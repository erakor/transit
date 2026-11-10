import { AGENCIES, findStop, routeInfo, searchStops, type Agency } from "../agency/agencies.js";
import { computeAgencyArrivals } from "../agency/arrivals.js";
import type { AgencyStop } from "../agency/types.js";
import { computeAgencyVehicles } from "../agency/vehicles.js";
import { computeAlerts } from "../alerts.js";
import { ALERTS_CACHE, authenticated, errorResponse, intParam, json, LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE, text } from "../http.js";
import { destinationsLine } from "../preview.js";
import { fetchFeed, type FeedMessage, type Fetcher } from "../subway/feeds.js";
import { busAlerts, loadAlertsFeed } from "./alerts.js";

export interface AgencyDeps {
  fetcher?: Fetcher;
  now?: () => number;
}

type Context = { agency: Agency; url: URL; fetcher: Fetcher | undefined; nowMs: number };

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
 * number of them, and these routes share everything but their data.
 */
export function agencyHandler({ fetcher, now = () => Date.now() }: AgencyDeps = {}) {
  return authenticated(async (_request, url) => {
    const route = agencyRoute(url);
    if (route?.agency === "bus" && route.op === "alerts") return busAlerts(url, { fetcher, now });
    const agency = route ? AGENCIES[route.agency] : undefined;
    if (!route || !agency) return errorResponse(404, "not found");
    // The list is `/lirr/stations` but `/ferry/stops`, after what the agency calls a stop.
    const op = route.op === `${agency.stopParam}s` ? list : Object.hasOwn(OPS, route.op) ? OPS[route.op] : undefined;
    if (!op) return errorResponse(404, "not found");
    return op({ agency, url, fetcher, nowMs: now() });
  });
}

function unavailable(agency: Agency): Response {
  return errorResponse(502, `${agency.name} feed unavailable`);
}

async function load(feed: string, { fetcher, nowMs }: Context): Promise<FeedMessage | undefined> {
  try {
    return await fetchFeed(feed, { fetcher, now: nowMs });
  } catch (err) {
    console.error(`feed ${feed} failed:`, err);
    return undefined;
  }
}

const stopJson = (agency: Agency, s: AgencyStop) => ({
  id: s.id,
  name: s.name,
  lat: s.lat,
  lon: s.lon,
  routes: s.routes.map((r) => routeInfo(agency.data, r)),
});

const OPS: Record<string, (c: Context) => Promise<Response> | Response> = {
  /** GET /<agency>/arrivals?station=<id>&limit=<default 10, max 30> (`stop` for the ferry). */
  async arrivals(c) {
    const { agency, url } = c;
    const param = url.searchParams.get(agency.stopParam)?.trim();
    if (!param) return errorResponse(400, `${agency.stopParam} is required`);
    const limit = intParam(url, "limit", 10, 30);
    if (typeof limit !== "number") return errorResponse(400, limit.error);
    const stop = findStop(agency.data, param);
    if (!stop) return errorResponse(404, `unknown ${agency.stopParam} ${param}`);
    const feed = await load(agency.tripsFeed, c);
    if (!feed) return unavailable(agency);
    const { stop: resolved, ...rest } = computeAgencyArrivals(stop, feed, agency.data, { now: Math.floor(c.nowMs / 1000), limit });
    return json({ [agency.stopParam]: resolved, ...rest }, { cache: LIVE_CACHE });
  },

  /** GET /<agency>/alerts, optionally `?route=<id>` or `?station=<id>`: the alerts in effect now. */
  async alerts(c) {
    const { agency, url } = c;
    const routeParam = url.searchParams.get("route")?.trim();
    const stopParam = url.searchParams.get(agency.stopParam)?.trim();
    const stop = stopParam ? findStop(agency.data, stopParam) : undefined;
    if (stopParam && !stop) return errorResponse(404, `unknown ${agency.stopParam} ${stopParam}`);
    const feed = await loadAlertsFeed(agency.alertsFeed, c.fetcher, c.nowMs);
    if (!feed) return errorResponse(502, `${agency.name} alerts unavailable`);
    const result = computeAlerts(feed, {
      now: Math.floor(c.nowMs / 1000),
      match: (r, s) => {
        if (routeParam && r.toLowerCase() !== routeParam.toLowerCase()) return false;
        if (!stop) return true;
        // Alerts naming this stop, or a whole route that stops here.
        return s ? s === stop.id : stop.routes.includes(r);
      },
      route: (id) => routeInfo(agency.data, id),
      stopName: (id) => agency.data.stops[id]?.name,
    });
    return json(stop ? { [agency.stopParam]: { id: stop.id, name: stop.name }, ...result } : result, { cache: ALERTS_CACHE });
  },

  /** GET /<agency>/vehicles, optionally `?route=<id>`: where the trains or boats are. */
  async vehicles(c) {
    const { agency, url } = c;
    const routeParam = url.searchParams.get("route")?.trim();
    const route = routeParam ? Object.keys(agency.data.routes).find((id) => id.toLowerCase() === routeParam.toLowerCase()) : undefined;
    if (routeParam && !route) return errorResponse(404, `unknown route ${routeParam}`);
    const [positions, trips] = await Promise.all([
      load(agency.vehiclesFeed ?? agency.tripsFeed, c),
      agency.vehiclesFeed ? load(agency.tripsFeed, c) : undefined,
    ]);
    if (!positions) return unavailable(agency);
    const result = computeAgencyVehicles(trips ? [positions, trips] : [positions], agency.data, { now: Math.floor(c.nowMs / 1000), route });
    return json(result, { cache: LIVE_CACHE });
  },

  /** GET /preview/<agency>?q=<name> or ?station=<id>: one plain-text line, next departure per destination. */
  async preview(c) {
    const { agency, url } = c;
    const q = url.searchParams.get("q")?.trim();
    const param = url.searchParams.get(agency.stopParam)?.trim();
    if (!q && !param) return errorResponse(400, `q or ${agency.stopParam} is required`);
    if (q && q.length > 100) return errorResponse(400, "q is too long");
    const stop = param ? findStop(agency.data, param) : searchStops(agency.data, q!)[0];
    if (!stop) return errorResponse(404, param ? `unknown ${agency.stopParam} ${param}` : `no matching ${agency.stopParam}`);
    const feed = await load(agency.tripsFeed, c);
    if (!feed) return unavailable(agency);
    const nowS = Math.floor(c.nowMs / 1000);
    const { arrivals } = computeAgencyArrivals(stop, feed, agency.data, { now: nowS, limit: 200 });
    // A trip ending here is nobody's departure.
    const departures = arrivals.filter((a) => a.headsign !== stop.name).map((a) => ({ label: a.headsign || a.name, time: a.time }));
    return text(destinationsLine(stop.name, departures, nowS, `no ${agency.vehicleWord} soon`), { cache: PREVIEW_CACHE });
  },
};

/** GET /<agency>/stations (`/ferry/stops`): all of them by name, or `?q=<name>&limit=<default 10, max 25>`. */
function list({ agency, url }: Context): Response {
  const q = url.searchParams.get("q")?.trim();
  if (q && q.length > 100) return errorResponse(400, "q is too long");
  const limit = intParam(url, "limit", 10, 25);
  if (typeof limit !== "number") return errorResponse(400, limit.error);
  const key = `${agency.stopParam}s`;
  if (q) return json({ query: q, [key]: searchStops(agency.data, q).slice(0, limit).map((s) => stopJson(agency, s)) }, { cache: STATIC_CACHE });
  const all = Object.values(agency.data.stops).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return json({ [key]: all.map((s) => stopJson(agency, s)) }, { cache: STATIC_CACHE });
}
