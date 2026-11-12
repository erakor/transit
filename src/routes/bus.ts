import { busRoute, computeBusArrivals } from '#src/bus/arrivals.js'
import { BusAlertsQuery, BusArrivalsQuery, BusPreviewQuery } from '#src/bus/schemas.js'
import { fetchStopMonitoring, type StopMonitoring } from '#src/bus/siri.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { computeAlerts } from '#src/alerts.js'
import { tryFetchFeed, tryLoad, type Fetcher } from '#src/gtfsrt.js'
import { ALERTS_CACHE, authenticated, byOp, errorResponse, json, LIVE_CACHE, PREVIEW_CACHE, text } from '#src/http.js'
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

/**
 * One stop's answer from Bus Time, or the response to send instead: 500 without a key, 404 for a
 * stop Bus Time doesn't know, 502 when it fails.
 */
async function loadStop(
  stop: string,
  { fetcher, busKey = envKey }: BusDeps,
  nowMs: number
): Promise<StopMonitoring | Response> {
  const key = busKey()
  if (!key) {
    console.error('BUSTIME_KEY is not set')
    return errorResponse(500, 'bus arrivals not configured')
  }
  const answer = await tryLoad(`bustime stop ${stop}`, () => fetchStopMonitoring(stop, key, { fetcher, now: nowMs }))
  if (!answer) return errorResponse(502, 'Bus Time unavailable')
  if (answer.error) {
    if (/no such stop/i.test(answer.error)) return errorResponse(404, `unknown stop ${stop}`)
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
    const departures = arrivals.flatMap(a => (a.time === null ? [] : [{ label: a.name, time: a.time }]))
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
    const routeParam = parsed.query.route?.toUpperCase()
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
  })
}
