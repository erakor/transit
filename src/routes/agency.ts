import { AGENCIES, findStop, routeInfo, searchStops, type Agency } from '#src/agency/agencies.js'
import { computeAgencyArrivals } from '#src/agency/arrivals.js'
import { computeAgencyVehicles } from '#src/agency/vehicles.js'
import { AgencyVehiclesQuery, STOP_SCHEMAS } from '#src/agency/schemas.js'
import { computeAlerts } from '#src/alerts.js'
import { tryFetchFeed, type FeedMessage, type Fetcher } from '#src/gtfsrt.js'
import {
  ALERTS_CACHE,
  authenticated,
  errorResponse,
  json,
  LIVE_CACHE,
  PREVIEW_CACHE,
  STATIC_CACHE,
  text,
} from '#src/http.js'
import { destinationsLine } from '#src/preview.js'
import { parseQuery } from '#src/schema.js'

export interface AgencyDeps {
  fetcher?: Fetcher
  now?: () => number
}

interface Context {
  agency: Agency
  url: URL
  /** Epoch seconds. */
  now: number
  load(feed: string): Promise<FeedMessage | undefined>
}

/**
 * Which agency and operation a request is for. vercel.json rewrites `/lirr/arrivals` to
 * `/api/agency?agency=lirr&op=arrivals`; the public path is read first and the query second, so
 * the handler works whichever of the two URLs the platform hands it (and in tests, the public one).
 */
export function agencyRoute(url: URL): { agency: string; op: string } | undefined {
  const path = /^\/([a-z]+)\/([a-z]+)\/?$/.exec(url.pathname)
  if (path && path[1] !== 'api')
    return path[1] === 'preview' ? { agency: path[2]!, op: 'preview' } : { agency: path[1]!, op: path[2]! }
  const agency = url.searchParams.get('agency')
  const op = url.searchParams.get('op')
  return agency && op ? { agency, op } : undefined
}

/**
 * One function for every agency: `/lirr/...`, `/mnr/...`, `/ferry/...` and `/preview/<agency>`.
 * A single function because a deployment has a limited number of them, and these routes share
 * everything but their data. It must not import the subway's station index, which would bundle
 * the subway data into it.
 */
export function agencyHandler({ fetcher, now = () => Date.now() }: AgencyDeps = {}) {
  return authenticated(async (_request, url) => {
    const route = agencyRoute(url)
    const nowMs = now()
    const load = (feed: string) => tryFetchFeed(feed, { fetcher, now: nowMs })
    const nowS = Math.floor(nowMs / 1000)
    const agency = route ? AGENCIES[route.agency] : undefined
    if (!route || !agency) return errorResponse(404, 'not found')
    // The list is `/lirr/stations` but `/ferry/stops`, after what the agency calls a stop.
    const op = route.op === `${agency.stopParam}s` ? list : Object.hasOwn(OPS, route.op) ? OPS[route.op] : undefined
    if (!op) return errorResponse(404, 'not found')
    return op({ agency, url, now: nowS, load })
  })
}

function unavailable(agency: Agency): Response {
  return errorResponse(502, `${agency.name} feed unavailable`)
}

const OPS: Record<string, (c: Context) => Promise<Response> | Response> = {
  /** GET /<agency>/arrivals?station=<id>&limit=<default 10, max 30> (`stop` for the ferry). */
  async arrivals({ agency, url, now, load }) {
    const parsed = parseQuery(STOP_SCHEMAS[agency.stopParam].ArrivalsQuery, url)
    if (!parsed.ok) return parsed.response
    const { stop: param, limit } = parsed.query
    const stop = findStop(agency.data, param)
    if (!stop) return errorResponse(404, `unknown ${agency.stopParam} ${param}`)
    const feed = await load(agency.tripsFeed)
    if (!feed) return unavailable(agency)
    const { stop: resolved, ...rest } = computeAgencyArrivals(stop, feed, agency.data, { now, limit })
    return json({ [agency.stopParam]: resolved, ...rest }, { cache: LIVE_CACHE })
  },

  /** GET /<agency>/alerts, optionally `?route=<id>` or `?station=<id>`: the alerts in effect now. */
  async alerts({ agency, url, now, load }) {
    const parsed = parseQuery(STOP_SCHEMAS[agency.stopParam].AlertsQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route?.toLowerCase()
    const stopParam = parsed.query.stop
    const stop = stopParam ? findStop(agency.data, stopParam) : undefined
    if (stopParam && !stop) return errorResponse(404, `unknown ${agency.stopParam} ${stopParam}`)
    const feed = await load(agency.alertsFeed)
    if (!feed) return errorResponse(502, `${agency.name} alerts unavailable`)
    const result = computeAlerts(feed, {
      now,
      match: (r, s) => {
        if (routeParam && r.toLowerCase() !== routeParam) return false
        if (!stop) return true
        // Alerts naming this stop, or a whole route that stops here.
        return s ? s === stop.id : stop.routes.includes(r)
      },
      route: id => agency.data.routes[id],
      // Their `direction_id`s have no documented meaning in alerts: no direction is shown.
      stop: id => {
        const name = agency.data.stops[id]?.name
        return name ? { id, name, direction: null } : undefined
      },
    })
    return json(stop ? { [agency.stopParam]: { id: stop.id, name: stop.name }, ...result } : result, {
      cache: ALERTS_CACHE,
    })
  },

  /** GET /<agency>/vehicles, optionally `?route=<id>`: where the trains or boats are. */
  async vehicles({ agency, url, now, load }) {
    const parsed = parseQuery(AgencyVehiclesQuery, url)
    if (!parsed.ok) return parsed.response
    const routeParam = parsed.query.route?.toLowerCase()
    const route = routeParam ? Object.keys(agency.data.routes).find(id => id.toLowerCase() === routeParam) : undefined
    if (routeParam && !route) return errorResponse(404, `unknown route ${routeParam}`)
    // The feed with the positions is required; separate trip updates only add routes and headsigns.
    const [positions, trips] = await Promise.all([
      load(agency.vehiclesFeed ?? agency.tripsFeed),
      agency.vehiclesFeed ? load(agency.tripsFeed) : undefined,
    ])
    if (!positions) return unavailable(agency)
    return json(computeAgencyVehicles(trips ? [positions, trips] : [positions], agency.data, { now, route }), {
      cache: LIVE_CACHE,
    })
  },

  /** GET /preview/<agency>?q=<name> or ?station=<id>: one plain-text line, next departure per destination. */
  async preview({ agency, url, now, load }) {
    const parsed = parseQuery(STOP_SCHEMAS[agency.stopParam].PreviewQuery, url)
    if (!parsed.ok) return parsed.response
    const { id } = parsed.query
    const stop = id !== undefined ? findStop(agency.data, id) : searchStops(agency.data, parsed.query.q)[0]
    if (!stop)
      return errorResponse(
        404,
        id !== undefined ? `unknown ${agency.stopParam} ${id}` : `no matching ${agency.stopParam}`
      )
    const feed = await load(agency.tripsFeed)
    if (!feed) return unavailable(agency)
    const { arrivals } = computeAgencyArrivals(stop, feed, agency.data, { now, limit: Infinity })
    // A trip ending here is nobody's departure.
    const departures = arrivals
      .filter(a => a.headsign !== stop.name)
      .map(a => ({ label: a.headsign || a.name, time: a.time }))
    return text(destinationsLine(stop.name, departures, now, `no ${agency.vehicleWord} soon`), {
      cache: PREVIEW_CACHE,
    })
  },
}

/** GET /<agency>/stations (`/ferry/stops`): all of them by name, or `?q=<name>&limit=<default 10, max 25>`. */
function list({ agency, url }: Context): Response {
  const parsed = parseQuery(STOP_SCHEMAS[agency.stopParam].StopsQuery, url)
  if (!parsed.ok) return parsed.response
  const { q, limit } = parsed.query
  const stops = q
    ? searchStops(agency.data, q).slice(0, limit)
    : Object.values(agency.data.stops).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const body = stops.map(s => ({
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    routes: s.routes.map(r => routeInfo(agency.data, r)),
  }))
  return json({ ...(q ? { query: q } : {}), [`${agency.stopParam}s`]: body }, { cache: STATIC_CACHE })
}
