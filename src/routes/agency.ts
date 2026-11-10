import { AGENCIES, findStop, routeInfo, searchStops, type Agency } from "../agency/agencies.js";
import { computeAgencyArrivals } from "../agency/arrivals.js";
import { computeAgencyVehicles } from "../agency/vehicles.js";
import { computeAlerts } from "../alerts.js";
import { tryFetchFeed, type FeedMessage, type Fetcher } from "../gtfsrt.js";
import { ALERTS_CACHE, authenticated, errorResponse, intParam, json, LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE, text } from "../http.js";
import { destinationsLine } from "../preview.js";

export const BUS_ALERTS_FEED = "camsys/bus-alerts";

export interface AgencyDeps {
  fetcher?: Fetcher;
  now?: () => number;
}

interface Context {
  agency: Agency;
  url: URL;
  /** Epoch seconds. */
  now: number;
  load(feed: string): Promise<FeedMessage | undefined>;
}

/**
 * Which agency and operation a request is for. vercel.json rewrites `/lirr/arrivals` to
 * `/api/agency?agency=lirr&op=arrivals`; the public path is read first and the query second, so
 * the handler works whichever of the two URLs the platform hands it (and in tests, the public one).
 */
export function agencyRoute(url: URL): { agency: string; op: string } | undefined {
  const path = /^\/([a-z]+)\/([a-z]+)\/?$/.exec(url.pathname);
  if (path && path[1] !== "api") return path[1] === "preview" ? { agency: path[2]!, op: "preview" } : { agency: path[1]!, op: path[2]! };
  const agency = url.searchParams.get("agency");
  const op = url.searchParams.get("op");
  return agency && op ? { agency, op } : undefined;
}

/**
 * One function for every agency without code of its own: `/lirr/...`, `/mnr/...`, `/ferry/...`,
 * `/preview/<agency>` and `/bus/alerts`. A single function because a deployment has a limited
 * number of them, and these routes share everything but their data. It must not import the
 * subway's station index, which would bundle the subway data into it.
 */
export function agencyHandler({ fetcher, now = () => Date.now() }: AgencyDeps = {}) {
  return authenticated(async (_request, url) => {
    const route = agencyRoute(url);
    const nowMs = now();
    const load = (feed: string) => tryFetchFeed(feed, { fetcher, now: nowMs });
    const nowS = Math.floor(nowMs / 1000);
    if (route?.agency === "bus" && route.op === "alerts") return busAlerts(url, nowS, load);
    const agency = route ? AGENCIES[route.agency] : undefined;
    if (!route || !agency) return errorResponse(404, "not found");
    // The list is `/lirr/stations` but `/ferry/stops`, after what the agency calls a stop.
    const op = route.op === `${agency.stopParam}s` ? list : Object.hasOwn(OPS, route.op) ? OPS[route.op] : undefined;
    if (!op) return errorResponse(404, "not found");
    return op({ agency, url, now: nowS, load });
  });
}

function unavailable(agency: Agency): Response {
  return errorResponse(502, `${agency.name} feed unavailable`);
}

/**
 * `/bus/alerts?route=<id>` (all of them without `route`). Not an agency: there is no static bus
 * data yet, so routes carry their id as name and no stop is named.
 */
async function busAlerts(url: URL, now: number, load: Context["load"]): Promise<Response> {
  const routeParam = url.searchParams.get("route")?.trim().toUpperCase();
  const feed = await load(BUS_ALERTS_FEED);
  if (!feed) return errorResponse(502, "MTA alerts unavailable");
  const result = computeAlerts(feed, { now, match: routeParam ? (r) => r.toUpperCase() === routeParam : undefined });
  return json(result, { cache: ALERTS_CACHE });
}

const OPS: Record<string, (c: Context) => Promise<Response> | Response> = {
  /** GET /<agency>/arrivals?station=<id>&limit=<default 10, max 30> (`stop` for the ferry). */
  async arrivals({ agency, url, now, load }) {
    const param = url.searchParams.get(agency.stopParam)?.trim();
    if (!param) return errorResponse(400, `${agency.stopParam} is required`);
    const limit = intParam(url, "limit", 10, 30);
    if (typeof limit !== "number") return errorResponse(400, limit.error);
    const stop = findStop(agency.data, param);
    if (!stop) return errorResponse(404, `unknown ${agency.stopParam} ${param}`);
    const feed = await load(agency.tripsFeed);
    if (!feed) return unavailable(agency);
    const { stop: resolved, ...rest } = computeAgencyArrivals(stop, feed, agency.data, { now, limit });
    return json({ [agency.stopParam]: resolved, ...rest }, { cache: LIVE_CACHE });
  },

  /** GET /<agency>/alerts, optionally `?route=<id>` or `?station=<id>`: the alerts in effect now. */
  async alerts({ agency, url, now, load }) {
    const routeParam = url.searchParams.get("route")?.trim().toLowerCase();
    const stopParam = url.searchParams.get(agency.stopParam)?.trim();
    const stop = stopParam ? findStop(agency.data, stopParam) : undefined;
    if (stopParam && !stop) return errorResponse(404, `unknown ${agency.stopParam} ${stopParam}`);
    const feed = await load(agency.alertsFeed);
    if (!feed) return errorResponse(502, `${agency.name} alerts unavailable`);
    const result = computeAlerts(feed, {
      now,
      match: (r, s) => {
        if (routeParam && r.toLowerCase() !== routeParam) return false;
        if (!stop) return true;
        // Alerts naming this stop, or a whole route that stops here.
        return s ? s === stop.id : stop.routes.includes(r);
      },
      route: (id) => agency.data.routes[id],
      stopName: (id) => agency.data.stops[id]?.name,
    });
    return json(stop ? { [agency.stopParam]: { id: stop.id, name: stop.name }, ...result } : result, { cache: ALERTS_CACHE });
  },

  /** GET /<agency>/vehicles, optionally `?route=<id>`: where the trains or boats are. */
  async vehicles({ agency, url, now, load }) {
    const routeParam = url.searchParams.get("route")?.trim().toLowerCase();
    const route = routeParam ? Object.keys(agency.data.routes).find((id) => id.toLowerCase() === routeParam) : undefined;
    if (routeParam && !route) return errorResponse(404, `unknown route ${routeParam}`);
    // The feed with the positions is required; separate trip updates only add routes and headsigns.
    const [positions, trips] = await Promise.all([load(agency.vehiclesFeed ?? agency.tripsFeed), agency.vehiclesFeed ? load(agency.tripsFeed) : undefined]);
    if (!positions) return unavailable(agency);
    return json(computeAgencyVehicles(trips ? [positions, trips] : [positions], agency.data, { now, route }), { cache: LIVE_CACHE });
  },

  /** GET /preview/<agency>?q=<name> or ?station=<id>: one plain-text line, next departure per destination. */
  async preview({ agency, url, now, load }) {
    const q = url.searchParams.get("q")?.trim();
    const param = url.searchParams.get(agency.stopParam)?.trim();
    if (!q && !param) return errorResponse(400, `q or ${agency.stopParam} is required`);
    if (q && q.length > 100) return errorResponse(400, "q is too long");
    const stop = param ? findStop(agency.data, param) : searchStops(agency.data, q!)[0];
    if (!stop) return errorResponse(404, param ? `unknown ${agency.stopParam} ${param}` : `no matching ${agency.stopParam}`);
    const feed = await load(agency.tripsFeed);
    if (!feed) return unavailable(agency);
    const { arrivals } = computeAgencyArrivals(stop, feed, agency.data, { now, limit: Infinity });
    // A trip ending here is nobody's departure.
    const departures = arrivals.filter((a) => a.headsign !== stop.name).map((a) => ({ label: a.headsign || a.name, time: a.time }));
    return text(destinationsLine(stop.name, departures, now, `no ${agency.vehicleWord} soon`), { cache: PREVIEW_CACHE });
  },
};

/** GET /<agency>/stations (`/ferry/stops`): all of them by name, or `?q=<name>&limit=<default 10, max 25>`. */
function list({ agency, url }: Context): Response {
  const q = url.searchParams.get("q")?.trim();
  if (q && q.length > 100) return errorResponse(400, "q is too long");
  const limit = intParam(url, "limit", 10, 25);
  if (typeof limit !== "number") return errorResponse(400, limit.error);
  const stops = q
    ? searchStops(agency.data, q).slice(0, limit)
    : Object.values(agency.data.stops).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const body = stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, routes: s.routes.map((r) => routeInfo(agency.data, r)) }));
  return json({ ...(q ? { query: q } : {}), [`${agency.stopParam}s`]: body }, { cache: STATIC_CACHE });
}
