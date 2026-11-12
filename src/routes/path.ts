import { authenticated, errorResponse, json, LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE, text } from '#src/http.js'
import { computePathArrivals } from '#src/path/arrivals.js'
import { fetchPathFeed, type PathFeed } from '#src/path/feed.js'
import { pathPreviewLine } from '#src/path/preview.js'
import { PathArrivalsQuery, PathPreviewQuery, type PathStationsResponse } from '#src/path/schemas.js'
import { parseQuery } from '#src/schema.js'
import { PATH_STATIONS, pathStation, routesOf, searchPathStations } from '#src/path/stations.js'
import type { Fetcher } from '#src/gtfsrt.js'

export interface PathDeps {
  fetcher?: Fetcher
  now?: () => number
}

async function loadFeed(fetcher: Fetcher | undefined, nowMs: number): Promise<PathFeed | undefined> {
  try {
    return await fetchPathFeed({ fetcher, now: nowMs })
  } catch (err) {
    console.error('PATH feed failed:', err)
    return undefined
  }
}

/** GET /path/arrivals?station=<id>&limit=<per route and direction, default 3, max 10> */
export function pathArrivalsHandler({ fetcher, now = () => Date.now() }: PathDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(PathArrivalsQuery, url)
    if (!parsed.ok) return parsed.response
    const { station: stationParam, limit } = parsed.query
    const station = pathStation(stationParam)
    if (!station) return errorResponse(404, `unknown station ${stationParam}`)

    const nowMs = now()
    const feed = await loadFeed(fetcher, nowMs)
    if (!feed) return errorResponse(502, 'PATH feed unavailable')
    return json(computePathArrivals(station, feed, { now: Math.floor(nowMs / 1000), limit }), { cache: LIVE_CACHE })
  })
}

/** GET /path/stations: the 13 stations with the routes serving them. */
export function pathStationsHandler() {
  return authenticated(() =>
    json(
      {
        stations: PATH_STATIONS.map(s => ({ id: s.id, name: s.name, routes: routesOf(s) })),
      } satisfies PathStationsResponse,
      { cache: STATIC_CACHE }
    )
  )
}

/**
 * GET /preview/path?q=<station name> or ?station=<id>: one plain-text line with the next train
 * to each destination, for a launcher hint. Errors are JSON like every other route.
 */
export function pathPreviewHandler({ fetcher, now = () => Date.now() }: PathDeps = {}) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(PathPreviewQuery, url)
    if (!parsed.ok) return parsed.response
    const { id } = parsed.query

    const station = id !== undefined ? pathStation(id) : searchPathStations(parsed.query.q)[0]
    if (!station) return errorResponse(404, id !== undefined ? `unknown station ${id}` : 'no matching station')

    const nowMs = now()
    const feed = await loadFeed(fetcher, nowMs)
    if (!feed) return errorResponse(502, 'PATH feed unavailable')
    const nowS = Math.floor(nowMs / 1000)
    return text(pathPreviewLine(computePathArrivals(station, feed, { now: nowS, limit: 1 }), nowS), {
      cache: PREVIEW_CACHE,
    })
  })
}
