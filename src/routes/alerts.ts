import { computeAlerts, type AlertRoute } from "../alerts.js";
import { ALERTS_CACHE, authenticated, errorResponse, json } from "../http.js";
import { stationIndex, type StationIndex } from "../stops/stations.js";
import { fetchFeed, type FeedMessage, type Fetcher } from "../subway/feeds.js";

export const SUBWAY_ALERTS_FEED = "camsys/subway-alerts";
export const BUS_ALERTS_FEED = "camsys/bus-alerts";

export interface AlertsDeps {
  fetcher?: Fetcher;
  now?: () => number;
  index?: () => StationIndex;
}

export const FALLBACK_ROUTE = (id: string): AlertRoute => ({ id, name: id, color: "#808183", textColor: "#FFFFFF" });

/** The alerts feed, or undefined (logged) when the upstream fails. */
export async function loadAlertsFeed(feed: string, fetcher: Fetcher | undefined, nowMs: number): Promise<FeedMessage | undefined> {
  try {
    return await fetchFeed(feed, { fetcher, now: nowMs });
  } catch (err) {
    console.error(`feed ${feed} failed:`, err);
    return undefined;
  }
}

/**
 * GET /subway/alerts?route=<id> or ?stop=<station, stop or platform id>: the alerts in effect
 * now. With `stop`: alerts naming one of its stops, or a whole route that stops there. With
 * neither: every subway alert in effect.
 */
export function subwayAlertsHandler({ fetcher, now = () => Date.now(), index = stationIndex }: AlertsDeps = {}) {
  return authenticated(async (_request, url) => {
    const idx = index();
    const routeParam = url.searchParams.get("route")?.trim().toUpperCase();
    const stopParam = url.searchParams.get("stop")?.trim();
    if (routeParam && !idx.data.routes[routeParam]) return errorResponse(404, `unknown route ${routeParam}`);
    const stop = stopParam ? idx.resolve(stopParam) : undefined;
    if (stopParam && !stop) return errorResponse(404, `unknown stop ${stopParam}`);

    const nowMs = now();
    const feed = await loadAlertsFeed(SUBWAY_ALERTS_FEED, fetcher, nowMs);
    if (!feed) return errorResponse(502, "MTA alerts unavailable");
    const stops = new Set(stop?.stops);
    const result = computeAlerts(feed, {
      now: Math.floor(nowMs / 1000),
      match: (r, s) => {
        if (routeParam && r !== routeParam) return false;
        if (!stop) return true;
        // Alerts name parent stops or platforms.
        return s ? stops.has(s) || stops.has(s.replace(/[NS]$/, "")) : stop.routes.includes(r);
      },
      route: (id) => {
        const r = idx.data.routes[id];
        return r ? { id, name: r.shortName, color: r.color, textColor: r.textColor } : FALLBACK_ROUTE(id);
      },
      stopName: (id) => idx.stopName(id),
    });
    return json(stop ? { stop: { id: stop.id, name: stop.name, stops: stop.stops }, ...result } : result, { cache: ALERTS_CACHE });
  });
}

/**
 * Bus alerts for `/bus/alerts?route=<id>` (all of them without `route`). There is no static bus
 * data yet, so routes carry their id as name and no stop is named.
 */
export async function busAlerts(url: URL, { fetcher, now = () => Date.now() }: AlertsDeps): Promise<Response> {
  const routeParam = url.searchParams.get("route")?.trim().toUpperCase();
  const nowMs = now();
  const feed = await loadAlertsFeed(BUS_ALERTS_FEED, fetcher, nowMs);
  if (!feed) return errorResponse(502, "MTA alerts unavailable");
  const result = computeAlerts(feed, {
    now: Math.floor(nowMs / 1000),
    match: routeParam ? (r) => r.toUpperCase() === routeParam : undefined,
    route: FALLBACK_ROUTE,
    stopName: () => undefined,
  });
  return json(result, { cache: ALERTS_CACHE });
}
