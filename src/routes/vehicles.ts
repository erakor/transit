import { authenticated, errorResponse, json, LIVE_CACHE } from '#src/http.js'
import { parseQuery } from '#src/schema.js'
import { VehiclesQuery } from '#src/subway/schemas.js'
import { stationIndex } from '#src/stops/stations.js'
import { tryFetchFeed } from '#src/gtfsrt.js'
import { feedsForRoutes } from '#src/subway/feeds.js'
import { computeSubwayTrains } from '#src/subway/vehicles.js'
import type { ArrivalsDeps } from './arrivals.js'

/** GET /subway/vehicles?route=<id>: the stop each of the route's trains is at or heading to. */
export function subwayVehiclesHandler({ fetcher, now = () => Date.now(), index = stationIndex }: ArrivalsDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(VehiclesQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route.toUpperCase()
    const idx = index()
    const route = idx.data.routes[routeParam]
    const feedName = feedsForRoutes([routeParam])[0]
    if (!route || !feedName) return errorResponse(404, `unknown route ${routeParam}`)

    const nowMs = now()
    const feed = await tryFetchFeed(feedName, { fetcher, now: nowMs })
    if (!feed) return errorResponse(502, 'MTA feeds unavailable')
    return json(computeSubwayTrains(route, feed, idx, { now: Math.floor(nowMs / 1000) }), { cache: LIVE_CACHE })
  })
}
