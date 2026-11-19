import { authenticated, errorResponse, json, LIVE_CACHE } from '#src/http.js'
import { parseQuery } from '#src/query.js'
import { ArrivalsQuery } from '#src/subway/queries.js'
import type { ArrivalsResponse } from '#src/subway/schemas.js'
import { stationIndex, type StationIndex } from '#src/stops/stations.js'
import type { Fetcher } from '#src/memo.js'
import { loadArrivals } from '#src/subway/load.js'

/** Shorter CDN window when some feeds failed, so a full answer comes back soon. */
const PARTIAL_CACHE = 'public, s-maxage=5'

export interface ArrivalsDeps {
  fetcher?: Fetcher
  now?: () => number
  index?: () => StationIndex
}

/** GET /subway/arrivals?stop=<station, stop or platform id>&limit=<per route and direction, default 3, max 10> */
export function arrivalsHandler({
  fetcher,
  now = () => Date.now(),
  index = stationIndex,
}: ArrivalsDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(ArrivalsQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop: stopParam, limit } = parsed.query

    const idx = index()
    const stop = idx.resolve(stopParam)
    if (!stop) return errorResponse('unknown_stop', `unknown stop ${stopParam}`)

    const nowMs = now()
    const loaded = await loadArrivals(stop, idx, { fetcher, nowMs, limit })
    if (!loaded) return errorResponse('upstream_unavailable', 'MTA feeds unavailable')
    const { result, failed } = loaded
    const body: ArrivalsResponse = failed.length ? { ...result, unavailableFeeds: failed } : result
    return json(body, { cache: failed.length ? PARTIAL_CACHE : LIVE_CACHE })
  })
}
