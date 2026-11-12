import { busRoute, computeBusArrivals } from '#src/bus/arrivals.js'
import { BusAlertsQuery, BusArrivalsQuery, BusPreviewQuery } from '#src/bus/schemas.js'
import { fetchStopMonitoring, type StopMonitoring } from '#src/bus/siri.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { computeAlerts } from '#src/alerts.js'
import { tryLoad, type FeedMessage, type Fetcher } from '#src/gtfsrt.js'
import { ALERTS_CACHE, errorResponse, json, LIVE_CACHE, PREVIEW_CACHE, text } from '#src/http.js'
import { destinationsLine } from '#src/preview.js'
import { parseQuery } from '#src/schema.js'

export const BUS_ALERTS_FEED = 'camsys/bus-alerts'

export interface BusDeps {
  fetcher?: Fetcher
  /** The MTA Bus Time API key; by default `BUSTIME_KEY` from the environment. */
  busKey?: () => string | undefined
}

export interface BusContext {
  url: URL
  /** Epoch milliseconds. */
  nowMs: number
  /** The GTFS-realtime feeds, as the agency handler loads them. */
  load(feed: string): Promise<FeedMessage | undefined>
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

/**
 * The bus routes, served by the agency function (`api/agency.ts`): a deployment has a limited
 * number of functions, and the bus data is small (route names and colors).
 */
export const BUS_OPS: Record<string, (c: BusContext, deps: BusDeps) => Promise<Response>> = {
  /** GET /bus/arrivals?stop=<stop code>&limit=<default 10, max 30>: the buses on their way. */
  async arrivals({ url, nowMs }, deps) {
    const parsed = parseQuery(BusArrivalsQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop, limit } = parsed.query
    const answer = await loadStop(stop, deps, nowMs)
    if (answer instanceof Response) return answer
    return json(computeBusArrivals(stop, answer, BUS_DATA.routes, { limit }), { cache: LIVE_CACHE })
  },

  /** GET /preview/bus?stop=<stop code>: one plain-text line, the next bus of each route. */
  async preview({ url, nowMs }, deps) {
    const parsed = parseQuery(BusPreviewQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop } = parsed.query
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
  },

  /** GET /bus/alerts?route=<id> (all of them without `route`). No stop is named: there is no bus stop data. */
  async alerts({ url, nowMs, load }) {
    const parsed = parseQuery(BusAlertsQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route?.toUpperCase()
    const feed = await load(BUS_ALERTS_FEED)
    if (!feed) return errorResponse(502, 'MTA alerts unavailable')
    const result = computeAlerts(feed, {
      now: Math.floor(nowMs / 1000),
      match: routeParam ? r => r.toUpperCase() === routeParam : undefined,
      route: id => busRoute(BUS_DATA.routes, id),
    })
    return json(result, { cache: ALERTS_CACHE })
  },
}
