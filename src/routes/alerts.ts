import { computeAlerts } from '#src/alerts.js'
import { tryFetchFeed } from '#src/gtfsrt.js'
import { ALERTS_CACHE, authenticated, errorResponse, json } from '#src/http.js'
import { parseQuery } from '#src/schema.js'
import { AlertsQuery, type AlertsResponse } from '#src/subway/schemas.js'
import { stationIndex } from '#src/stops/stations.js'
import type { ArrivalsDeps } from './arrivals.js'

export const SUBWAY_ALERTS_FEED = 'camsys/subway-alerts'

/**
 * GET /subway/alerts?route=<id> or ?stop=<station, stop or platform id>: the alerts in effect
 * now. With `stop`: alerts naming one of its stops, or a whole route that stops there. With
 * neither: every subway alert in effect.
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
    const result = computeAlerts(feed, {
      now: Math.floor(nowMs / 1000),
      match: (r, s) => {
        if (routeParam && r !== routeParam) return false
        if (!stop) return true
        // Alerts name parent stops or platforms.
        return s ? stops.has(s) || stops.has(s.replace(/[NS]$/, '')) : stop.routes.includes(r)
      },
      route: id => {
        const r = idx.data.routes[id]
        return r && { id, name: r.shortName, color: r.color, textColor: r.textColor }
      },
      stopName: id => idx.stopName(id),
    })
    const body: AlertsResponse = stop
      ? { stop: { id: stop.id, name: stop.name, stops: stop.stops }, ...result }
      : result
    return json(body, { cache: ALERTS_CACHE })
  })
}
