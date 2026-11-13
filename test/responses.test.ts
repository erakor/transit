import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { GET as healthGET } from '../api/health.js'
import { SUBWAY_DATA } from '#src/data/subway.generated.js'
import { ROUTES } from '#src/openapi.js'
import { agencyHandler } from '#src/routes/agency.js'
import { subwayAlertsHandler } from '#src/routes/alerts.js'
import { arrivalsHandler } from '#src/routes/arrivals.js'
import { citibikeHandler } from '#src/routes/citibike.js'
import { busHandler } from '#src/routes/bus.js'
import { pathHandler } from '#src/routes/path.js'
import { subwayPreviewHandler } from '#src/routes/preview.js'
import { searchHandler } from '#src/routes/search.js'
import { subwayVehiclesHandler } from '#src/routes/vehicles.js'
import { ErrorBody } from '#src/schema.js'
import {
  auth,
  BUS_FIXTURE_NOW_MS,
  BUS_ROUTE,
  BUS_STOP,
  BUS_STOP_POINT,
  fixtureFetcher,
  FIXTURE_NOW_MS,
  get,
  PATH_FIXTURE_NOW_MS,
  useRouteTestSetup,
} from './helpers.js'

useRouteTestSetup()

type Handler = (request: Request) => Promise<Response> | Response

/** A handler serving the recorded feeds at the time they were recorded. */
const HANDLERS: Record<string, () => Handler> = {
  '/subway/arrivals': () => arrivalsHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/stops/search': () => searchHandler(),
  '/subway/alerts': () => subwayAlertsHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/subway/vehicles': () => subwayVehiclesHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/preview/subway': () => subwayPreviewHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/path/': () => pathHandler({ fetcher: fixtureFetcher(), now: () => PATH_FIXTURE_NOW_MS }),
  '/preview/path': () => pathHandler({ fetcher: fixtureFetcher(), now: () => PATH_FIXTURE_NOW_MS }),
  '/bus/alerts': () => busHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/bus/': () => busHandler({ fetcher: fixtureFetcher(), now: () => BUS_FIXTURE_NOW_MS }),
  '/preview/bus': () => busHandler({ fetcher: fixtureFetcher(), now: () => BUS_FIXTURE_NOW_MS }),
  // The Citi Bike feeds were recorded at another time, but a station's counts don't expire.
  '/citibike/': () => citibikeHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  '/health': () => healthGET,
  '/': () => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
}

const handlerFor = (path: string) => HANDLERS[Object.keys(HANDLERS).find(prefix => path.startsWith(prefix))!]!()

const TIMES_SQ = encodeURIComponent(SUBWAY_DATA.stops['127']!.station)

/** Requests to every documented route, several where the answer's shape depends on the query. */
const REQUESTS = [
  `/subway/arrivals?stop=${TIMES_SQ}`,
  '/stops/search?q=times',
  '/subway/alerts',
  '/subway/alerts?route=A',
  `/subway/alerts?stop=${TIMES_SQ}`,
  '/subway/vehicles?route=L',
  '/preview/subway?q=bedford',
  '/path/arrivals?station=WTC',
  '/path/stations',
  '/preview/path?q=hoboken',
  '/lirr/arrivals?station=102',
  '/lirr/stations',
  '/lirr/stations?q=jamaica',
  '/lirr/alerts',
  '/lirr/alerts?station=102',
  '/lirr/vehicles',
  '/preview/lirr?q=jamaica',
  '/mnr/arrivals?station=1',
  '/mnr/stations?q=rye',
  '/mnr/alerts',
  '/mnr/vehicles',
  '/preview/mnr?station=1',
  '/ferry/arrivals?stop=87',
  '/ferry/stops',
  '/ferry/alerts?stop=87',
  '/ferry/vehicles',
  '/preview/ferry?q=wall',
  `/bus/arrivals?stop=${BUS_STOP}`,
  `/preview/bus?stop=${BUS_STOP}`,
  '/bus/alerts',
  '/bus/alerts?route=M15',
  `/bus/vehicles?route=${encodeURIComponent(BUS_ROUTE)}`,
  `/bus/nearby?lat=${BUS_STOP_POINT.lat}&lon=${BUS_STOP_POINT.lon}`,
  '/citibike/station?id=f72a253f-3cef-4da8-9591-0cbd3a692162',
  '/citibike/nearby?lat=40.7559&lon=-73.9871',
  '/health',
]

describe('documented routes', () => {
  it('each have a request here', () => {
    const requested = new Set(REQUESTS.map(r => r.split('?')[0]))
    expect(ROUTES.map(r => r.path).filter(p => !requested.has(p))).toEqual([])
  })

  it.each(REQUESTS)('%s answers what its schema says', async request => {
    const path = request.split('?')[0]!
    const route = ROUTES.find(r => r.path === path)!
    const res = await handlerFor(path)(get(request, auth))
    expect(res.status).toBe(200)
    if (route.response === 'text') {
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
      return
    }
    const body = await res.json()
    const parsed = route.response.safeParse(body)
    expect(parsed.error?.issues ?? []).toEqual([])
  })

  it.each(ROUTES.filter(r => Object.hasOwn(r.errors, 404)))(
    '$path answers its 404 in the error schema',
    async route => {
      // The route's id parameter, the one an unknown value of is a 404.
      const params = Object.keys(z.toJSONSchema(route.query, { io: 'input' }).properties ?? {})
      const param = ['stop', 'station', 'id', 'route'].find(p => params.includes(p))
      // Bus stop codes have a format: anything else is a 400, before Bus Time is asked. Bus Time
      // decides which routes exist: ZZZ is its recorded answer for one it doesn't run.
      const unknown = route.path === '/bus/vehicles' ? 'ZZZ' : route.tag === 'Bus' ? '999999' : 'nope'
      const res = await handlerFor(route.path)(get(`${route.path}?${param}=${unknown}`, auth))
      expect(res.status).toBe(404)
      expect(ErrorBody.safeParse(await res.json()).success).toBe(true)
    }
  )
})
