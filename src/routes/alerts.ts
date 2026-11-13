import { computeAlerts } from '#src/alerts.js'
import { tryFetchFeed } from '#src/gtfsrt.js'
import { ALERTS_CACHE, authenticated, errorResponse, json } from '#src/http.js'
import { parseQuery } from '#src/schema.js'
import { AlertsQuery, type AlertsResponse } from '#src/subway/schemas.js'
import { stationIndex } from '#src/stops/stations.js'
import type { ArrivalsDeps } from './arrivals.js'

export const SUBWAY_ALERTS_FEED = 'camsys/subway-alerts'

/** Alerts name parent stops (`711`) or platforms (`711S`). */
const parentStop = (stopId: string) => stopId.replace(/[NS]$/, '')

/**
 * The one direction an alert's informed entity affects at a stop: the platform it names, or its
 * `direction_id`, which the MTA documents as 0 for northbound and 1 for southbound.
 */
function subwayDirection(stopId: string, directionId: number | undefined): 'N' | 'S' | null {
  const platform = /[NS]$/.exec(stopId)?.[0]
  if (platform === 'N' || platform === 'S') return platform
  return directionId === 0 ? 'N' : directionId === 1 ? 'S' : null
}

/**
 * GET /subway/alerts?route=<id> or ?stop=<station, stop or platform id>: the alerts in effect
 * now. With `stop`: alerts naming one of its stops (for a platform, in its direction), or a
 * whole route that stops there. With neither: every subway alert in effect.
 */
export function subwayAlertsHandler({ fetcher, now = () => Date.now(), index = stationIndex }: ArrivalsDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(AlertsQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route?.toUpperCase()
    const stopParam = parsed.query.stop
    const idx = index()
    if (routeParam && !idx.data.routes[routeParam]) return errorResponse(404, `unknown route ${routeParam}`)
    const stop = stopParam ? idx.resolve(stopParam) : undefined
    if (stopParam && !stop) return errorResponse(404, `unknown stop ${stopParam}`)

    const nowMs = now()
    const feed = await tryFetchFeed(SUBWAY_ALERTS_FEED, { fetcher, now: nowMs })
    if (!feed) return errorResponse(502, 'MTA alerts unavailable')
    const stops = new Set(stop?.stops)
    // A platform asked for: its direction. Alerts for the other one don't apply there.
    const platform = stop?.platforms.length === 1 ? stop.platforms[0]!.slice(-1) : undefined
    const result = computeAlerts(feed, {
      now: Math.floor(nowMs / 1000),
      match: (r, s, d) => {
        if (routeParam && r !== routeParam) return false
        if (!stop) return true
        if (!s) return stop.routes.includes(r)
        const direction = subwayDirection(s, d)
        return stops.has(parentStop(s)) && !(platform && direction && direction !== platform)
      },
      route: id => {
        const r = idx.data.routes[id]
        return r && { id, name: r.shortName, color: r.color, textColor: r.textColor }
      },
      stop: (s, d) => {
        const name = idx.stopName(s)
        return name ? { id: parentStop(s), name, direction: subwayDirection(s, d) } : undefined
      },
    })
    const body: AlertsResponse = stop
      ? { stop: { id: stop.id, name: stop.name, stops: stop.stops }, ...result }
      : result
    return json(body, { cache: ALERTS_CACHE })
  })
}
