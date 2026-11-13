import { describe, expect, it, vi } from 'vitest'
import { busRoute, computeBusArrivals } from '#src/bus/arrivals.js'
import {
  parseStopMonitoring,
  parseVehicleMonitoring,
  stopMonitoringUrl,
  stripOperator,
  vehicleMonitoringUrl,
  type StopMonitoring,
} from '#src/bus/siri.js'
import { nearestBusStops, parseStopsForLocation, stopsForLocationUrl } from '#src/bus/stops.js'
import { compassHeading, computeBusVehicles, findBusRoute } from '#src/bus/vehicles.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { LIVE_CACHE, PREVIEW_CACHE, providerOp, STATIC_CACHE } from '#src/http.js'
import { busHandler } from '#src/routes/bus.js'
import { buildBusData } from '#src/static/bus.js'
import {
  auth,
  BUS_FIXTURE_NOW_MS,
  BUS_KEY,
  BUS_ROUTE,
  BUS_STOP,
  BUS_STOP_POINT,
  fixture,
  fixtureFetcher,
  FIXTURE_NOW_MS,
  get,
  useRouteTestSetup,
} from './helpers.js'

useRouteTestSetup()

const NOW = Math.floor(BUS_FIXTURE_NOW_MS / 1000)
const json = (name: string): unknown => JSON.parse(new TextDecoder().decode(fixture(name)))
const recorded = () => parseStopMonitoring(json(`bustime-${BUS_STOP}.json`))
/** 13:30 on the day of the hand-built answers, as their times say it. */
const HALF_PAST = Date.parse('2026-11-10T13:30:00-05:00') / 1000
const recordedVehicles = () => parseVehicleMonitoring(json(`bustime-vehicles-${BUS_ROUTE}.json`))

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
    // Recorded late in the evening: M15 buses still finishing their trips the other way.
    expect(visits).toHaveLength(6)
    expect(visits[0]).toEqual({
      routeId: 'M15',
      publishedName: 'M15',
      destination: 'EAST HARLEM 125 ST via 1 AV',
      tripId: 'MTA NYCT_OH_D6-Weekday-SDon-133000_M15_239',
      vehicle: '5923',
      time: NOW + 2565,
      distanceText: '4.6 miles away',
      stopsAway: 18,
      meters: 7440,
      notYetDeparted: true,
      cancelled: false,
      stopName: '1 AV/E 14 ST',
    })
    for (const v of visits) {
      expect(v.routeId).toBe('M15')
      expect(v.tripId).not.toBe('')
      expect(v.stopName).toBe('1 AV/E 14 ST')
    }
    expect(visits.filter(v => v.time === undefined)).toHaveLength(2)
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
        time: HALF_PAST,
        distanceText: '1 stop away',
        stopsAway: 1,
        meters: 301,
        notYetDeparted: true,
        cancelled: false,
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

  it('reads cancelled trips, SIRI 2 and SIRI 1, at their scheduled time', () => {
    const call = { AimedArrivalTime: '2026-11-10T13:30:00-05:00', StopPointName: ['1 AV/E 14 ST'] }
    const { visits } = parseStopMonitoring(
      siri([
        { LineRef: 'MTA NYCT_M15', VehicleStatus: 'cancelled', MonitoredCall: call },
        {
          LineRef: 'MTA NYCT_M15',
          MonitoredCall: { ...call, ArrivalStatus: 'cancelled', DepartureStatus: 'cancelled' },
        },
        // A bus running late keeps its prediction and is not cancelled.
        { LineRef: 'MTA NYCT_M15', MonitoredCall: { ...call, ExpectedArrivalTime: '2026-11-10T13:31:00-05:00' } },
      ])
    )
    expect(visits.map(v => [v.cancelled, v.time])).toEqual([
      [true, HALF_PAST],
      [true, HALF_PAST],
      [false, HALF_PAST + 60],
    ])
  })

  it('returns an error condition as the error', () => {
    const answer = parseStopMonitoring(json('bustime-999999.json'))
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

  it('asks for one stop, SIRI 2 with cancelled trips, with the key', () => {
    const url = new URL(stopMonitoringUrl('401687', 'k&y'))
    expect(url.origin + url.pathname).toBe('https://bustime.mta.info/api/2/siri/stop-monitoring.json')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      key: 'k&y',
      version: '2',
      MonitoringRef: '401687',
      // `minimum` leaves out the line ref.
      StopMonitoringDetailLevel: 'basic',
    })
  })
})

describe('computeBusArrivals', () => {
  it('lists predicted buses soonest first, then the others nearest first, with route names and colors', () => {
    const r = computeBusArrivals(BUS_STOP, recorded(), BUS_DATA.routes, { limit: 10 })
    expect(r.stop).toEqual({ id: BUS_STOP, name: '1 AV/E 14 ST' })
    expect(r.updatedAt).toBe(NOW)
    expect(r.arrivals.map(a => [a.name, a.time === null ? null : a.time - NOW, a.meters])).toEqual([
      ['M15', 2252, 8145],
      ['M15', 2565, 7440],
      ['M15', 3165, 10353],
      ['M15', 3277, 11061],
      ['M15', null, 10279],
      ['M15', null, 11675],
    ])
    expect(r.arrivals[0]).toMatchObject({
      route: 'M15',
      color: BUS_DATA.routes.M15!.color,
      distance: '5.1 miles away',
      atTerminal: true,
      cancelled: false,
    })
    expect(computeBusArrivals(BUS_STOP, recorded(), BUS_DATA.routes, { limit: 2 }).arrivals).toHaveLength(2)
  })

  it('orders untimed buses by distance', () => {
    const answer: StopMonitoring = {
      updatedAt: null,
      visits: [4000, 900].map(meters => ({
        ...recorded().visits[0]!,
        time: undefined,
        meters,
        tripId: String(meters),
      })),
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

describe('bus vehicles', () => {
  it('reads the recorded buses of a route', () => {
    const { updatedAt, error, vehicles } = recordedVehicles()
    expect(updatedAt).toBe(NOW)
    expect(error).toBeUndefined()
    expect(vehicles).toHaveLength(11)
    expect(vehicles[0]).toEqual({
      routeId: 'M15+',
      publishedName: 'M15-SBS',
      destination: 'SELECT BUS SERVICE SOUTH FERRY via 2 AV',
      tripId: 'MTA NYCT_OF_D6-Weekday-SDon-121500_SBS15_454',
      vehicle: '6218',
      lat: 40.707984,
      lon: -74.003537,
      bearing: 225,
      stopId: '405338',
      stopName: 'PEARL ST/BEEKMAN ST',
      distanceText: 'at stop',
      stopsAway: 0,
      notYetDeparted: false,
      recordedAt: NOW - 1,
    })
  })

  it('lists them by headsign, with compass headings and their next stop', () => {
    const vehicles = computeBusVehicles(recordedVehicles())
    expect(new Set(vehicles.map(v => v.headsign))).toEqual(
      new Set(['SELECT BUS SERVICE 125 ST via 1 AV', 'SELECT BUS SERVICE SOUTH FERRY via 2 AV'])
    )
    expect(vehicles.map(v => v.headsign)).toEqual([...vehicles.map(v => v.headsign)].sort())
    expect(vehicles.find(v => v.id === '6218')).toMatchObject({
      heading: 225,
      stop: { id: '405338', name: 'PEARL ST/BEEKMAN ST' },
      atTerminal: false,
      time: NOW - 1,
    })
    for (const v of vehicles) {
      expect(v.lat).toBeGreaterThan(40.6)
      expect(v.lat).toBeLessThan(40.9)
      expect(v.stop?.id).toMatch(/^\d{6}$/)
    }
  })

  it('turns Bus Time bearings (0 east, counterclockwise) into compass headings', () => {
    expect([0, 90, 180, 270, 225, 359.6, -10].map(compassHeading)).toEqual([90, 0, 270, 180, 225, 90, 100])
  })

  it('returns an unknown route as the error', () => {
    expect(parseVehicleMonitoring(json('bustime-vehicles-ZZZ.json'))).toMatchObject({
      error: expect.stringContaining('No such route'),
      vehicles: [],
    })
    expect(() => parseVehicleMonitoring({ Siri: { ServiceDelivery: {} } })).toThrow('not a SIRI')
  })

  it('finds routes by id or by the name on the bus', () => {
    expect(findBusRoute(BUS_DATA.routes, 'm15-sbs')).toBe(BUS_DATA.routes['M15+'])
    expect(findBusRoute(BUS_DATA.routes, ' bx12 ')).toBe(BUS_DATA.routes.BX12)
    expect(findBusRoute(BUS_DATA.routes, 'M999')).toBeUndefined()
  })

  it('asks for one route, SIRI 2, with the key', () => {
    const url = new URL(vehicleMonitoringUrl('M15+', 'k&y'))
    expect(url.origin + url.pathname).toBe('https://bustime.mta.info/api/siri/vehicle-monitoring.json')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ key: 'k&y', version: '2', LineRef: 'M15+' })
  })
})

describe('nearby bus stops', () => {
  const stops = () => parseStopsForLocation(json('bustime-stops.json'))

  it('reads the recorded stops with their routes', () => {
    const all = stops()
    expect(all).toHaveLength(37)
    expect(all.find(s => s.code === BUS_STOP)).toEqual({
      code: BUS_STOP,
      name: '1 AV/E 14 ST',
      direction: 'NE',
      lat: BUS_STOP_POINT.lat,
      lon: BUS_STOP_POINT.lon,
      routeIds: ['M15'],
    })
    for (const s of all) {
      expect(s.code).toMatch(/^\d{6}$/)
      for (const r of s.routeIds) expect(BUS_DATA.routes[r], r).toBeDefined()
    }
  })

  it('lists the nearest stops first, with route names and colors', () => {
    const near = nearestBusStops(stops(), BUS_STOP_POINT.lat, BUS_STOP_POINT.lon, BUS_DATA.routes, 4)
    expect(near.map(s => [s.id, s.direction, s.distance, s.routes.map(r => r.name)])).toEqual([
      [BUS_STOP, 'NE', 0, ['M15']],
      ['405322', 'NE', 2, ['M15-SBS']],
      ['404029', 'NW', 108, ['L92', 'M14A-SBS', 'M14D-SBS']],
      ['401193', 'SE', 117, ['L92', 'M14A-SBS', 'M14D-SBS']],
    ])
    expect(near[1]!.routes[0]).toEqual(BUS_DATA.routes['M15+'])
  })

  it('rejects answers that are not a stop list, as a bad key gets', () => {
    for (const body of [null, {}, { code: 401, text: 'permission denied' }, { code: 200, data: {} }])
      expect(() => parseStopsForLocation(body)).toThrow('not a stop list')
  })

  it('asks around a rounded point, with the key', () => {
    const url = new URL(stopsForLocationUrl(40.7321223, -73.9819456, 500, 'k&y'))
    expect(url.hostname).toBe('bustime-classic.mta.info')
    expect(Object.fromEntries(url.searchParams)).toEqual({ lat: '40.7321', lon: '-73.9819', radius: '500', key: 'k&y' })
  })
})

describe('bus routes', () => {
  function call(path: string, fail: string[] = [], busKey?: () => string | undefined, nowMs = BUS_FIXTURE_NOW_MS) {
    const fetcher = fixtureFetcher(fail)
    const handler = busHandler({ fetcher, now: () => nowMs, ...(busKey ? { busKey } : {}) })
    return { fetcher, res: handler(get(path, auth)) }
  }

  it('reads the operation from the public path or the rewritten query', () => {
    const op = (path: string) => providerOp(new URL(`https://transit.test${path}`), 'bus')
    expect(op('/bus/arrivals?stop=1')).toBe('arrivals')
    expect(op('/preview/bus?stop=1')).toBe('preview')
    expect(op('/api/bus?op=arrivals&stop=1')).toBe('arrivals')
  })

  it('answers the buses at a stop, live-cached, varying on the token', async () => {
    const { res, fetcher } = call(`/bus/arrivals?stop=${BUS_STOP}&limit=2`)
    const r = await res
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe(LIVE_CACHE)
    expect(r.headers.get('vary')).toBe('x-transit-token')
    const body = await r.json()
    expect(body.stop).toEqual({ id: BUS_STOP, name: '1 AV/E 14 ST' })
    expect(body.arrivals.map((a: { name: string }) => a.name)).toEqual(['M15', 'M15'])
    expect(fetcher.calls).toEqual([`bustime-${BUS_STOP}.json`])
  })

  it('accepts the stop as Bus Time writes it', async () => {
    const r = await call(`/api/bus?op=arrivals&stop=MTA_${BUS_STOP}`).res
    expect(r.status).toBe(200)
    expect((await r.json()).stop.id).toBe(BUS_STOP)
  })

  it('asks Bus Time once per stop within the memo window', async () => {
    const fetcher = fixtureFetcher()
    const handler = busHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS })
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
    ['/bus/lirr', 404, 'not found'],
    ['/api/bus', 404, 'not found'],
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
    expect(await r.json()).toEqual({ error: 'bus data not configured' })
    expect(fetcher.calls).toEqual([])
    expect(console.error).toHaveBeenCalledWith('BUSTIME_KEY is not set')
  })

  it('previews the next bus of each route', async () => {
    const r = await call(`/preview/bus?stop=${BUS_STOP}`).res
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe(PREVIEW_CACHE)
    expect(await r.text()).toBe('1 AV/E 14 ST · M15 37 min\n')
  })

  it('leaves cancelled buses out of the preview', async () => {
    const at = (min: number) => new Date((NOW + min * 60) * 1000).toISOString()
    const body = siri([
      {
        LineRef: 'MTA NYCT_M15',
        VehicleStatus: 'cancelled',
        MonitoredCall: { AimedArrivalTime: at(2), StopPointName: 'X' },
      },
      { LineRef: 'MTA NYCT_M15', MonitoredCall: { ExpectedArrivalTime: at(9), StopPointName: 'X' } },
    ])
    const fetcher = async () => Response.json(body)
    const handler = busHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS })
    expect(await (await handler(get(`/preview/bus?stop=${BUS_STOP}`, auth))).text()).toBe('X · M15 9 min\n')
    const arrivals = (await (await handler(get(`/bus/arrivals?stop=${BUS_STOP}`, auth))).json()).arrivals
    expect(arrivals.map((a: { cancelled: boolean }) => a.cancelled)).toEqual([true, false])
  })

  it('answers the buses of a route, live-cached', async () => {
    const { res, fetcher } = call('/bus/vehicles?route=m15-sbs')
    const r = await res
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe(LIVE_CACHE)
    const body = await r.json()
    expect(body.route).toEqual(BUS_DATA.routes['M15+'])
    expect(body.updatedAt).toBe(NOW)
    expect(body.vehicles).toHaveLength(11)
    expect(fetcher.calls).toEqual(['bustime-vehicles-M15+.json'])
    // `+` sent encoded reaches the same route.
    expect((await call('/api/bus?op=vehicles&route=M15%2B').res).status).toBe(200)
  })

  it("answers 404 for a route Bus Time doesn't run", async () => {
    const fetcher = async () => Response.json(json('bustime-vehicles-ZZZ.json'))
    const r = await busHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS })(get('/bus/vehicles?route=M15', auth))
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'unknown route M15' })
  })

  it('answers the stops near a point, cached like static data', async () => {
    const { lat, lon } = BUS_STOP_POINT
    const { res, fetcher } = call(`/bus/nearby?lat=${lat}&lon=${lon}&limit=3`)
    const r = await res
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe(STATIC_CACHE)
    const body = await r.json()
    expect(body.stops.map((s: { id: string }) => s.id)).toEqual([BUS_STOP, '405322', '404029'])
    expect(fetcher.calls).toEqual(['bustime-stops.json'])
  })

  it('is 502 when the stop lookup fails or answers no list, without logging the key', async () => {
    const { lat, lon } = BUS_STOP_POINT
    expect((await call(`/bus/nearby?lat=${lat}&lon=${lon}`, ['bustime-stops.json']).res).status).toBe(502)
    const fetcher = async () => Response.json(null)
    const r = await busHandler({ fetcher, now: () => BUS_FIXTURE_NOW_MS + 1 })(
      get(`/bus/nearby?lat=${lat + 0.01}&lon=${lon}`, auth)
    )
    expect(r.status).toBe(502)
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join('\n')).not.toContain(BUS_KEY)
  })

  it.each([
    ['/bus/vehicles', 400, 'route is required'],
    ['/bus/vehicles?route=M999', 404, 'unknown route M999'],
    ['/bus/nearby?lon=-73.98', 400, 'lat is required'],
    ['/bus/nearby?lat=91&lon=-73.98', 400, 'lat must be a number between -90 and 90'],
  ])('rejects %s with %i, asking nobody', async (path, status, error) => {
    const { res, fetcher } = call(path)
    const r = await res
    expect(r.status).toBe(status)
    expect(await r.json()).toEqual({ error })
    expect(fetcher.calls).toEqual([])
  })

  it('is 500 for vehicles and nearby stops without a key', async () => {
    for (const path of ['/bus/vehicles?route=M15', '/bus/nearby?lat=40.7&lon=-73.9']) {
      const r = await call(path, [], () => undefined).res
      expect(r.status).toBe(500)
      expect(await r.json()).toEqual({ error: 'bus data not configured' })
    }
  })

  it('returns bus alerts by route, whatever the case, with route names and colors', async () => {
    const all = await (await call('/bus/alerts', [], undefined, FIXTURE_NOW_MS).res).json()
    const routeId: string = all.alerts[0].routes[0].id
    const one = await (
      await call(`/bus/alerts?route=${routeId.toLowerCase()}`, [], undefined, FIXTURE_NOW_MS).res
    ).json()
    expect(one.alerts.length).toBeGreaterThan(0)
    expect(one.alerts.length).toBeLessThan(all.alerts.length)
    expect(one.alerts[0].routes).toContainEqual(BUS_DATA.routes[routeId])
    // Select Bus Service routes are `+` in the feed and `-SBS` on the bus.
    const sbs = all.alerts
      .flatMap((a: { routes: { id: string; name: string }[] }) => a.routes)
      .find((r: { id: string }) => r.id.endsWith('+'))
    expect(sbs.name).toBe(sbs.id.replace('+', '-SBS').replace(/^BX/, 'Bx'))
  })

  it('/bus/alerts is 502 when its feed fails', async () => {
    const r = await call('/bus/alerts', ['bus-alerts'], undefined, FIXTURE_NOW_MS).res
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'MTA alerts unavailable' })
  })
})
