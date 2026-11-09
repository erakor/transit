import { authenticated, errorResponse, intParam, json, LIVE_CACHE } from "../http.js";
import { stationIndex, type StationIndex } from "../stops/stations.js";
import { computeArrivals } from "../subway/arrivals.js";
import { feedsForRoutes, fetchFeed, type Fetcher } from "../subway/feeds.js";

/** Shorter CDN window when some feeds failed, so a full answer comes back soon. */
const PARTIAL_CACHE = "public, s-maxage=5";

export interface ArrivalsDeps {
  fetcher?: Fetcher;
  now?: () => number;
  index?: () => StationIndex;
}

/** GET /subway/arrivals?stop=<station, stop or platform id>&limit=<per route and direction, default 3, max 10> */
export function arrivalsHandler({ fetcher, now = () => Date.now(), index = stationIndex }: ArrivalsDeps = {}) {
  return authenticated(async (_request, url) => {
    const stopParam = url.searchParams.get("stop")?.trim();
    if (!stopParam) return errorResponse(400, "stop is required");
    const limit = intParam(url, "limit", 3, 10);
    if (typeof limit !== "number") return errorResponse(400, limit.error);

    const idx = index();
    const stop = idx.resolve(stopParam);
    if (!stop) return errorResponse(404, `unknown stop ${stopParam}`);

    const nowMs = now();
    const names = feedsForRoutes(stop.routes);
    const settled = await Promise.allSettled(names.map((f) => fetchFeed(f, { fetcher, now: nowMs })));
    const feeds = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const failed = names.filter((_, i) => settled[i]!.status === "rejected");
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") console.error(`feed ${names[i]} failed:`, s.reason);
    }
    if (names.length > 0 && feeds.length === 0) return errorResponse(502, "MTA feeds unavailable");

    const result = computeArrivals(stop, feeds, idx, { now: Math.floor(nowMs / 1000), limit });
    return json(
      failed.length ? { ...result, unavailableFeeds: failed } : result,
      { cache: failed.length ? PARTIAL_CACHE : LIVE_CACHE },
    );
  });
}
