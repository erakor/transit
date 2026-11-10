import { authenticated, errorResponse, json, LIVE_CACHE } from "../http.js";
import { stationIndex } from "../stops/stations.js";
import { feedsForRoutes, fetchFeed, type FeedMessage } from "../subway/feeds.js";
import { computeSubwayTrains } from "../subway/vehicles.js";
import type { ArrivalsDeps } from "./arrivals.js";

/** GET /subway/vehicles?route=<id>: the stop each of the route's trains is at or heading to. */
export function subwayVehiclesHandler({ fetcher, now = () => Date.now(), index = stationIndex }: ArrivalsDeps = {}) {
  return authenticated(async (_request, url) => {
    const routeParam = url.searchParams.get("route")?.trim().toUpperCase();
    if (!routeParam) return errorResponse(400, "route is required");
    const idx = index();
    const route = idx.data.routes[routeParam];
    const feedName = feedsForRoutes([routeParam])[0];
    if (!route || !feedName) return errorResponse(404, `unknown route ${routeParam}`);

    const nowMs = now();
    let feed: FeedMessage;
    try {
      feed = await fetchFeed(feedName, { fetcher, now: nowMs });
    } catch (err) {
      console.error(`feed ${feedName} failed:`, err);
      return errorResponse(502, "MTA feeds unavailable");
    }
    return json(computeSubwayTrains(route, feed, idx, { now: Math.floor(nowMs / 1000) }), { cache: LIVE_CACHE });
  });
}
