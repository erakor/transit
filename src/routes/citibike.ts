import { fetchGbfs } from '#src/citibike/feeds.js'
import { joinStations, nearestStations, type BikeStations } from '#src/citibike/stations.js'
import { NearbyQuery, StationQuery, type NearbyResponse, type StationResponse } from '#src/citibike/schemas.js'
import { authenticated, byOp, errorResponse, json, LIVE_CACHE } from '#src/http.js'
import { parseQuery } from '#src/schema.js'
import { tryLoad, type Fetcher } from '#src/gtfsrt.js'

export interface CitibikeDeps {
  fetcher?: Fetcher
  now?: () => number
}

type Loader = () => Promise<BikeStations | undefined>

/**
 * Loads both GBFS feeds and joins them. Resolves to undefined when either feed is unavailable: one
 * without the other is no answer. The last join is reused while both memoized feeds are the same
 * objects.
 */
function stationLoader({ fetcher, now = () => Date.now() }: CitibikeDeps): Loader {
  let last: { information: object; status: object; stations: BikeStations } | undefined
  return async () => {
    const opts = { fetcher, now: now() }
    const feeds = await tryLoad('citibike feeds', () =>
      Promise.all([fetchGbfs('station_information', opts), fetchGbfs('station_status', opts)])
    )
    if (!feeds) return undefined
    const [information, status] = feeds
    if (last?.information !== information || last.status !== status) {
      last = { information, status, stations: joinStations(information, status) }
    }
    return last.stations
  }
}

const UNAVAILABLE = 'Citi Bike feeds unavailable'

/** GET /citibike/station?id=<station id>: bikes, e-bikes and free docks at one station. */
export function citibikeStationHandler(deps: CitibikeDeps = {}) {
  return stationHandler(stationLoader(deps))
}

function stationHandler(loadStations: Loader) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(StationQuery, url)
    if (!parsed.ok) return parsed.response
    const { id } = parsed.query
    const stations = await loadStations()
    if (!stations) return errorResponse(502, UNAVAILABLE)
    const station = stations.byId.get(id)
    if (!station) return errorResponse(404, `unknown station ${id}`)
    return json({ updatedAt: stations.updatedAt, station } satisfies StationResponse, { cache: LIVE_CACHE })
  })
}

/** GET /citibike/nearby?lat=<lat>&lon=<lon>&n=<default 5, max 25>: the closest stations, nearest first. */
export function citibikeNearbyHandler(deps: CitibikeDeps = {}) {
  return nearbyHandler(stationLoader(deps))
}

function nearbyHandler(loadStations: Loader) {
  return authenticated(async (_request, url) => {
    const parsed = parseQuery(NearbyQuery, url)
    if (!parsed.ok) return parsed.response
    const { lat, lon, n } = parsed.query

    const stations = await loadStations()
    if (!stations) return errorResponse(502, UNAVAILABLE)
    const nearest = nearestStations(stations.byId.values(), lat, lon, n)
    return json({ lat, lon, updatedAt: stations.updatedAt, stations: nearest } satisfies NearbyResponse, {
      cache: LIVE_CACHE,
    })
  })
}

/**
 * One function for both Citi Bike routes (a deployment has a limited number of them), sharing one
 * station loader, so a request for either reuses the other's join.
 */
export function citibikeHandler(deps: CitibikeDeps = {}) {
  const loadStations = stationLoader(deps)
  return byOp('citibike', { station: stationHandler(loadStations), nearby: nearbyHandler(loadStations) })
}
