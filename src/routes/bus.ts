import { busRoute, busRouteId, computeBusArrivals, findBusRoute } from '#src/bus/arrivals.js'
import {
  BusAlertsQuery,
  BusArrivalsQuery,
  BusNearbyQuery,
  BusPreviewQuery,
  BusVehiclesQuery,
  type BusNearbyResponse,
  type BusVehiclesResponse,
} from '#src/bus/schemas.js'
import { fetchStopMonitoring, fetchVehicleMonitoring, type StopMonitoring } from '#src/bus/siri.js'
import { fetchStopsForLocation, nearestBusStops } from '#src/bus/stops.js'
import { computeBusVehicles } from '#src/bus/vehicles.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { computeAlerts } from '#src/alerts.js'
import { tryFetchFeed, tryLoad, type Fetcher } from '#src/gtfsrt.js'
import {
  ALERTS_CACHE,
  authenticated,
  byOp,
  errorResponse,
  json,
  LIVE_CACHE,
  PREVIEW_CACHE,
  STATIC_CACHE,
  text,
} from '#src/http.js'
import { destinationsLine } from '#src/preview.js'
import { parseQuery } from '#src/schema.js'

export const BUS_ALERTS_FEED = 'camsys/bus-alerts'

export interface BusDeps {
  fetcher?: Fetcher
  now?: () => number
  /** The MTA Bus Time API key; by default `BUSTIME_KEY` from the environment. */
  busKey?: () => string | undefined
}

const envKey = () => process.env.BUSTIME_KEY?.trim() || undefined

/** The key, or the 500 to answer without one. */
function requireKey({ busKey = envKey }: BusDeps): string | Response {
  const key = busKey()
  if (key) return key
  console.error('BUSTIME_KEY is not set')
  return errorResponse(500, 'bus data not configured')
}

/** How far `/bus/nearby` looks, in meters. */
export const NEARBY_RADIUS_M = 500

/**
 * One stop's answer from Bus Time, or the response to send instead: 500 without a key, 404 for a
 * stop Bus Time doesn't know, 502 when it fails.
 */
async function loadStop(stop: string, deps: BusDeps, nowMs: number): Promise<StopMonitoring | Response> {
  const key = requireKey(deps)
  if (key instanceof Response) return key
  const { fetcher } = deps
  const answer = await tryLoad(`bustime stop ${stop}`, () => fetchStopMonitoring(stop, key, { fetcher, now: nowMs }))
  if (!answer) return errorResponse(502, 'Bus Time unavailable')
  if (answer.error) {
    if (answer.notFound) return errorResponse(404, `unknown stop ${stop}`)
    console.error(`bustime stop ${stop}: ${answer.error}`)
    return errorResponse(502, 'Bus Time unavailable')
  }
  return answer
}

/** GET /bus/arrivals?stop=<stop code>&limit=<default 10, max 30>: the buses on their way. */
export function busArrivalsHandler(deps: BusDeps = {}) {
  const { now = () => Date.now() } = deps
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(BusArrivalsQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop, limit } = parsed.query
    const answer = await loadStop(stop, deps, now())
    if (answer instanceof Response) return answer
    return json(computeBusArrivals(stop, answer, BUS_DATA.routes, { limit }), { cache: LIVE_CACHE })
  })
}

/** GET /preview/bus?stop=<stop code>: one plain-text line, the next bus of each route. */
export function busPreviewHandler(deps: BusDeps = {}) {
  const { now = () => Date.now() } = deps
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(BusPreviewQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop } = parsed.query
    const nowMs = now()
    const answer = await loadStop(stop, deps, nowMs)
    if (answer instanceof Response) return answer
    const { stop: resolved, arrivals } = computeBusArrivals(stop, answer, BUS_DATA.routes, { limit: Infinity })
    // A cancelled bus won't come: the line shows the next one that will.
    const departures = arrivals.flatMap(a => (a.time === null || a.cancelled ? [] : [{ label: a.name, time: a.time }]))
    const line = destinationsLine(
      resolved.name ?? `Stop ${stop}`,
      departures,
      Math.floor(nowMs / 1000),
      'no buses soon'
    )
    return text(line, { cache: PREVIEW_CACHE })
  })
}

/** GET /bus/alerts?route=<id> (all of them without `route`). No stop is named: there is no bus stop data. */
export function busAlertsHandler({ fetcher, now = () => Date.now() }: BusDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(BusAlertsQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route && busRouteId(parsed.query.route)
    const nowMs = now()
    const feed = await tryFetchFeed(BUS_ALERTS_FEED, { fetcher, now: nowMs })
    if (!feed) return errorResponse(502, 'MTA alerts unavailable')
    const result = computeAlerts(feed, {
      now: Math.floor(nowMs / 1000),
      match: routeParam ? r => r.toUpperCase() === routeParam : undefined,
      route: id => busRoute(BUS_DATA.routes, id),
    })
    return json(result, { cache: ALERTS_CACHE })
  })
}

/** GET /bus/vehicles?route=<id>: where the route's buses are, both directions. */
export function busVehiclesHandler(deps: BusDeps = {}) {
  const { fetcher, now = () => Date.now() } = deps
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(BusVehiclesQuery, url)
    if (!parsed.ok) return parsed.response
    const route = findBusRoute(BUS_DATA.routes, parsed.query.route)
    if (!route) return errorResponse(404, `unknown route ${parsed.query.route}`)
    const key = requireKey(deps)
    if (key instanceof Response) return key
    const answer = await tryLoad(`bustime route ${route.id}`, () =>
      fetchVehicleMonitoring(route.id, key, { fetcher, now: now() })
    )
    if (!answer) return errorResponse(502, 'Bus Time unavailable')
    if (answer.error) {
      // A route in the static data that Bus Time doesn't run (yet, or any more).
      if (answer.notFound) return errorResponse(404, `unknown route ${route.id}`)
      console.error(`bustime route ${route.id}: ${answer.error}`)
      return errorResponse(502, 'Bus Time unavailable')
    }
    const body: BusVehiclesResponse = { route, updatedAt: answer.updatedAt, vehicles: computeBusVehicles(answer) }
    return json(body, { cache: LIVE_CACHE })
  })
}

/** GET /bus/nearby?lat=<deg>&lon=<deg>&limit=<default 10, max 25>: the bus stops around a point. */
export function busNearbyHandler(deps: BusDeps = {}) {
  const { fetcher, now = () => Date.now() } = deps
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(BusNearbyQuery, url)
    if (!parsed.ok) return parsed.response
    const { lat, lon, limit } = parsed.query
    const key = requireKey(deps)
    if (key instanceof Response) return key
    const stops = await tryLoad('bustime stops', () =>
      fetchStopsForLocation(lat, lon, NEARBY_RADIUS_M, key, { fetcher, now: now() })
    )
    if (!stops) return errorResponse(502, 'Bus Time unavailable')
    const body: BusNearbyResponse = { stops: nearestBusStops(stops, lat, lon, BUS_DATA.routes, limit) }
    // Stops change with the quarterly schedules.
    return json(body, { cache: STATIC_CACHE })
  })
}

/**
 * One function for the bus routes (`api/bus.ts`), behind rewrites like the agencies'
 * (`/bus/arrivals` to `/api/bus?op=arrivals`). Its own function rather than the agency one: a
 * different upstream with its own key and errors, and the bus stop data that stop search will
 * need is too large to bundle with the agencies.
 */
export function busHandler(deps: BusDeps = {}) {
  return byOp('bus', {
    arrivals: busArrivalsHandler(deps),
    preview: busPreviewHandler(deps),
    alerts: busAlertsHandler(deps),
    vehicles: busVehiclesHandler(deps),
    nearby: busNearbyHandler(deps),
  })
}
