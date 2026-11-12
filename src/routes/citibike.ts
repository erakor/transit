import { fetchGbfs } from '#src/citibike/feeds.js'
import { joinStations, nearestStations, type BikeStations } from '#src/citibike/stations.js'
import { authenticated, errorResponse, intParam, json, LIVE_CACHE } from '#src/http.js'
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
    const id = url.searchParams.get('id')?.trim()
    if (!id) return errorResponse(400, 'id is required')
    const stations = await loadStations()
    if (!stations) return errorResponse(502, UNAVAILABLE)
    const station = stations.byId.get(id)
    if (!station) return errorResponse(404, `unknown station ${id}`)
    return json({ updatedAt: stations.updatedAt, station }, { cache: LIVE_CACHE })
  })
}

function coordinate(url: URL, name: string, max: number): number | { error: string } {
  const raw = url.searchParams.get(name)?.trim()
  if (!raw) return { error: `${name} is required` }
  const value = Number(raw)
  // Decimal forms only (Number() alone would also take hex and binary literals).
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw) || Math.abs(value) > max)
    return { error: `${name} must be a number between -${max} and ${max}` }
  return value
}

/** GET /citibike/nearby?lat=<lat>&lon=<lon>&n=<default 5, max 25>: the closest stations, nearest first. */
export function citibikeNearbyHandler(deps: CitibikeDeps = {}) {
  return nearbyHandler(stationLoader(deps))
}

function nearbyHandler(loadStations: Loader) {
  return authenticated(async (_request, url) => {
    const lat = coordinate(url, 'lat', 90)
    if (typeof lat !== 'number') return errorResponse(400, lat.error)
    const lon = coordinate(url, 'lon', 180)
    if (typeof lon !== 'number') return errorResponse(400, lon.error)
    const n = intParam(url, 'n', 5, 25)
    if (typeof n !== 'number') return errorResponse(400, n.error)

    const stations = await loadStations()
    if (!stations) return errorResponse(502, UNAVAILABLE)
    return json(
      { lat, lon, updatedAt: stations.updatedAt, stations: nearestStations(stations.byId.values(), lat, lon, n) },
      { cache: LIVE_CACHE }
    )
  })
}

/**
 * The operation of a request: `/citibike/nearby` in the public path or, failing that, the `op`
 * query parameter that `vercel.json` adds (`/api/citibike?op=nearby`), so the handler works
 * whichever of the two URLs the platform hands it (and in tests, the public one).
 */
export function citibikeOp(url: URL): string | undefined {
  const path = /^\/citibike\/([a-z]+)\/?$/.exec(url.pathname)
  return path?.[1] ?? url.searchParams.get('op') ?? undefined
}

/**
 * One function for both Citi Bike routes (a deployment has a limited number of them), sharing one
 * station loader, so a request for either reuses the other's join.
 */
export function citibikeHandler(deps: CitibikeDeps = {}) {
  const loadStations = stationLoader(deps)
  const ops: Record<string, ReturnType<typeof authenticated>> = {
    station: stationHandler(loadStations),
    nearby: nearbyHandler(loadStations),
  }
  const notFound = authenticated(() => errorResponse(404, 'not found'))
  return (request: Request): Promise<Response> => {
    const op = citibikeOp(new URL(request.url))
    return (op && Object.hasOwn(ops, op) ? ops[op]! : notFound)(request)
  }
}
