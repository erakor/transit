import { describe, expect, it, vi } from 'vitest'
import { busRoute, computeBusArrivals } from '#src/bus/arrivals.js'
import { parseStopMonitoring, stopMonitoringUrl, stripOperator, type StopMonitoring } from '#src/bus/siri.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { LIVE_CACHE, PREVIEW_CACHE } from '#src/http.js'
import { agencyHandler, agencyRoute } from '#src/routes/agency.js'
import { buildBusData } from '#src/static/bus.js'
import {
  auth,
  BUS_FIXTURE_NOW_MS,
  BUS_KEY,
  BUS_STOP,
  fixture,
  fixtureFetcher,
  get,
  useRouteTestSetup,
} from './helpers.js'

useRouteTestSetup()

const NOW = Math.floor(BUS_FIXTURE_NOW_MS / 1000)
const recorded = () => parseStopMonitoring(JSON.parse(new TextDecoder().decode(fixture(`bustime-${BUS_STOP}.json`))))

/** A StopMonitoring body around `visits` (MonitoredVehicleJourney objects). */
function siri(visits: object[], extra: object = {}) {
  return {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: '2026-11-10T13:18:56.000-05:00',
        StopMonitoringDelivery: [{ MonitoredStopVisit: visits.map(j => ({ MonitoredVehicleJourney: j })), ...extra }],
      },
    },
  }
}

describe('buildBusData', () => {
  const borough = (routes: string, version = '20261009') => ({
    'routes.txt': `route_id,agency_id,route_short_name,route_long_name,route_color,route_text_color\n${routes}`,
    'feed_info.txt': `feed_publisher_name,feed_version\nMTA,${version}\n`,
  })

  it('keeps each route once, by id, under its short name, with the feeds’ versions', () => {
    const data = buildBusData([
      borough('M15+,MTA NYCT,M15-SBS,South Ferry - East Harlem,b933ad,\nB1,MTA NYCT,B1,Bay Ridge,,\n'),
      borough('M15+,MTA NYCT,changed,,000000,\n'),
      borough('Q06,MTABC,Q6,Jamaica,EE352E,FFFFFF\n', '20261012'),
    ])
    expect(Object.keys(data.routes)).toEqual(['B1', 'M15+', 'Q06'])
    expect(data.routes['M15+']).toEqual({ id: 'M15+', name: 'M15-SBS', color: '#B933AD', textColor: '#FFFFFF' })
    expect(data.routes.B1).toMatchObject({ color: '#808183' })
    expect(data.routes.Q06!.name).toBe('Q6')
    expect(data.feedVersion).toBe('20261009+20261012')
  })

  it('rejects feeds without routes', () => {
    expect(() => buildBusData([{ 'feed_info.txt': '' }])).toThrow('missing routes.txt')
    expect(() => buildBusData([borough('')])).toThrow('no routes')
  })

  it('generated the routes Bus Time and the alerts use', () => {
    expect(BUS_DATA.routes['M15+']).toMatchObject({ name: 'M15-SBS' })
    for (const id of ['M15', 'BX12', 'Q06', 'S79+', 'SIM10', 'X27']) expect(BUS_DATA.routes[id], id).toBeDefined()
  })
})

describe('parseStopMonitoring', () => {
  it('reads the visits of the fixture', () => {
    const { updatedAt, error, visits } = recorded()
    expect(updatedAt).toBe(NOW)
    expect(error).toBeUndefined()
    expect(visits).toHaveLength(4)
    expect(visits[0]).toEqual({
      routeId: 'M15+',
      publishedName: 'M15-SBS',
      destination: 'SBS EAST HARLEM 126 ST via 1 AV',
      tripId: 'MTA NYCT_MQ_D6-Weekday-SDon-077800_M15+_731',
      vehicle: '5791',
      time: NOW + 134,
      distanceText: 'approaching',
      stopsAway: 1,
      meters: 412,
      notYetDeparted: false,
      stopName: '1 AV/E 14 ST',
    })
    expect(visits[3]).toMatchObject({ routeId: 'M15', time: undefined, notYetDeparted: true, stopsAway: 22 })
  })

  it('reads the SIRI 1 distances and plain string names', () => {
    const { visits } = parseStopMonitoring(
      siri([
        {
          LineRef: 'MTABC_Q06',
          PublishedLineName: 'Q6',
          DestinationName: 'JAMAICA',
          ProgressStatus: 'prevTrip',
          MonitoredCall: {
            ExpectedDepartureTime: '2026-11-10T13:30:00-05:00',
            StopPointName: 'SUTPHIN BL/ARCHER AV',
            Extensions: {
              Distances: { PresentableDistance: '1 stop away', DistanceFromCall: 300.6, StopsFromCall: 1 },
            },
          },
        },
      ])
    )
    expect(visits).toEqual([
      {
        routeId: 'Q06',
        publishedName: 'Q6',
        destination: 'JAMAICA',
        tripId: '',
        vehicle: '',
        time: NOW + 664,
        distanceText: '1 stop away',
        stopsAway: 1,
        meters: 301,
        notYetDeparted: true,
        stopName: 'SUTPHIN BL/ARCHER AV',
      },
    ])
  })

  it('skips visits without a line, and reads odd values as unknown', () => {
    const { visits } = parseStopMonitoring(
      siri([
        {},
        { PublishedLineName: 'M1' },
        { LineRef: 'MTA NYCT_M1', MonitoredCall: { ExpectedArrivalTime: 'soon', DistanceFromStop: -1 } },
      ])
    )
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({ routeId: 'M1', time: undefined, meters: undefined, distanceText: '' })
  })

  it('returns an error condition as the error', () => {
    const answer = parseStopMonitoring(JSON.parse(new TextDecoder().decode(fixture('bustime-999999.json'))))
    expect(answer).toEqual({ updatedAt: NOW, error: 'No such stop: MTA_999999.', visits: [] })
  })

  it('throws on a body that is not SIRI', () => {
    for (const body of [null, {}, { Siri: { ServiceDelivery: {} } }, '<html>'])
      expect(() => parseStopMonitoring(body)).toThrow('not a SIRI')
  })

  it('strips operator prefixes', () => {
    expect(stripOperator('MTA NYCT_M15+')).toBe('M15+')
    expect(stripOperator('MTABC_Q06')).toBe('Q06')
    expect(stripOperator('MTA_401687')).toBe('401687')
    expect(stripOperator(undefined)).toBe('')
  })

  it('asks for one stop, SIRI 2, with the key', () => {
    const url = new URL(stopMonitoringUrl('401687', 'k&y'))
    expect(url.origin + url.pathname).toBe('https://bustime.mta.info/api/siri/stop-monitoring.json')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ key: 'k&y', version: '2', MonitoringRef: '401687' })
  })
})

describe('computeBusArrivals', () => {
  it('lists predicted buses soonest first, then the others nearest first, with route names and colors', () => {
    const r = computeBusArrivals(BUS_STOP, recorded(), BUS_DATA.routes, { limit: 10 })
    expect(r.stop).toEqual({ id: BUS_STOP, name: '1 AV/E 14 ST' })
    expect(r.updatedAt).toBe(NOW)
    expect(r.arrivals.map(a => [a.name, a.time === null ? null : a.time - NOW, a.atTerminal])).toEqual([
      ['M15-SBS', 134, false],
      ['M15', 344, false],
      ['M15-SBS', 729, false],
      ['M15', null, true],
    ])
    expect(r.arrivals[0]).toMatchObject({
      route: 'M15+',
      color: BUS_DATA.routes['M15+']!.color,
      distance: 'approaching',
    })
    expect(computeBusArrivals(BUS_STOP, recorded(), BUS_DATA.routes, { limit: 2 }).arrivals).toHaveLength(2)
  })

  it('orders untimed buses by distance', () => {
    const answer: StopMonitoring = {
      updatedAt: null,
      visits: [4000, 900].map(meters => ({ ...recorded().visits[3]!, meters, tripId: String(meters) })),
    }
    expect(computeBusArrivals('1', answer, {}, { limit: 10 }).arrivals.map(a => a.tripId)).toEqual(['900', '4000'])
  })

  it('names the stop null when no bus is coming', () => {
    expect(computeBusArrivals('400001', { updatedAt: 5, visits: [] }, {}, { limit: 10 })).toEqual({
      stop: { id: '400001', name: null },
      updatedAt: 5,
      arrivals: [],
    })
  })

  it('shows a route the static data lacks under the name on the bus', () => {
    expect(busRoute({}, 'M999', 'M999-SBS')).toEqual({
      id: 'M999',
      name: 'M999-SBS',
      color: '#808183',
      textColor: '#FFFFFF',
    })
    expect(busRoute(BUS_DATA.routes, 'bx12')).toBe(BUS_DATA.routes.BX12)
  })
})

describe('bus routes', () => {
  function call(path: string, fail: string[] = [], busKey?: () => string | undefined) {
    const fetcher = fixtureFetcher(fail)
    const handler = agencyHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS, ...(busKey ? { busKey } : {}) })
    return { fetcher, res: handler(get(path, auth)) }
  }

  it('reads the operation from the public path or the rewritten query', () => {
    const route = (path: string) => agencyRoute(new URL(`https://transit.test${path}`))
    expect(route('/bus/arrivals?stop=1')).toEqual({ agency: 'bus', op: 'arrivals' })
    expect(route('/preview/bus?stop=1')).toEqual({ agency: 'bus', op: 'preview' })
    expect(route('/api/agency?agency=bus&op=arrivals&stop=1')).toEqual({ agency: 'bus', op: 'arrivals' })
  })

  it('answers the buses at a stop, live-cached, varying on the token', async () => {
    const { res, fetcher } = call(`/bus/arrivals?stop=${BUS_STOP}&limit=2`)
    const r = await res
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe(LIVE_CACHE)
    expect(r.headers.get('vary')).toBe('x-transit-token')
    const body = await r.json()
    expect(body.stop).toEqual({ id: BUS_STOP, name: '1 AV/E 14 ST' })
    expect(body.arrivals.map((a: { name: string }) => a.name)).toEqual(['M15-SBS', 'M15'])
    expect(fetcher.calls).toEqual([`bustime-${BUS_STOP}.json`])
  })

  it('accepts the stop as Bus Time writes it', async () => {
    const r = await call(`/api/agency?agency=bus&op=arrivals&stop=MTA_${BUS_STOP}`).res
    expect(r.status).toBe(200)
    expect((await r.json()).stop.id).toBe(BUS_STOP)
  })

  it('asks Bus Time once per stop within the memo window', async () => {
    const fetcher = fixtureFetcher()
    const handler = agencyHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS })
    await handler(get(`/bus/arrivals?stop=${BUS_STOP}`, auth))
    await handler(get(`/preview/bus?stop=${BUS_STOP}`, auth))
    expect(fetcher.calls).toHaveLength(1)
  })

  it.each([
    ['/bus/arrivals', 400, 'stop is required'],
    ['/bus/arrivals?stop=%20', 400, 'stop is required'],
    ['/bus/arrivals?stop=40168', 400, 'stop must be a six-digit bus stop code'],
    ['/bus/arrivals?stop=abcdef', 400, 'stop must be a six-digit bus stop code'],
    [`/bus/arrivals?stop=${BUS_STOP}&limit=0`, 400, 'limit must be a positive integer'],
    ['/preview/bus', 400, 'stop is required'],
    ['/bus/arrivals?stop=999999', 404, 'unknown stop 999999'],
    ['/preview/bus?stop=999999', 404, 'unknown stop 999999'],
    ['/bus/stops', 404, 'not found'],
    ['/bus/toString', 404, 'not found'],
  ])('rejects %s with %i', async (path, status, error) => {
    const { res, fetcher } = call(path)
    const r = await res
    expect(r.status).toBe(status)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ error })
    if (status === 400) expect(fetcher.calls).toEqual([])
  })

  it('is 502 when Bus Time fails, without logging the key', async () => {
    for (const path of [`/bus/arrivals?stop=${BUS_STOP}`, `/preview/bus?stop=${BUS_STOP}`]) {
      const r = await call(path, [`bustime-${BUS_STOP}.json`]).res
      expect(r.status).toBe(502)
      expect(await r.json()).toEqual({ error: 'Bus Time unavailable' })
    }
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n')
    expect(logged).toContain(`bustime stop ${BUS_STOP}`)
    expect(logged).not.toContain(BUS_KEY)
  })

  it('is 500 without a key, and asks nobody', async () => {
    const { res, fetcher } = call(`/bus/arrivals?stop=${BUS_STOP}`, [], () => undefined)
    const r = await res
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ error: 'bus arrivals not configured' })
    expect(fetcher.calls).toEqual([])
    expect(console.error).toHaveBeenCalledWith('BUSTIME_KEY is not set')
  })

  it('previews the next bus of each route', async () => {
    const r = await call(`/preview/bus?stop=${BUS_STOP}`).res
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe(PREVIEW_CACHE)
    expect(await r.text()).toBe('1 AV/E 14 ST · M15-SBS 2 · M15 5 min\n')
  })
})
