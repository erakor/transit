import { authenticated, errorResponse, json, LIVE_CACHE } from "#src/http.js";
import { parseQuery } from "#src/schema.js";
import { ArrivalsQuery, type ArrivalsResponse } from "#src/subway/schemas.js";
import { stationIndex, type ResolvedStop, type StationIndex } from "#src/stops/stations.js";
import { computeArrivals, type ArrivalsResult } from "#src/subway/arrivals.js";
import { fetchFeed, type Fetcher } from "#src/gtfsrt.js";
import { feedsForRoutes } from "#src/subway/feeds.js";

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
    const parsed = parseQuery(ArrivalsQuery, url);
    if (!parsed.ok) return parsed.response;
    const { stop: stopParam, limit } = parsed.query;

    const idx = index();
    const stop = idx.resolve(stopParam);
    if (!stop) return errorResponse(404, `unknown stop ${stopParam}`);

    const nowMs = now();
    const loaded = await loadArrivals(stop, idx, { fetcher, nowMs, limit });
    if (!loaded) return errorResponse(502, "MTA feeds unavailable");
    const { result, failed } = loaded;
    const body: ArrivalsResponse = failed.length ? { ...result, unavailableFeeds: failed } : result;
    return json(body, { cache: failed.length ? PARTIAL_CACHE : LIVE_CACHE });
  });
}

/**
 * Fetches the feeds serving `stop` and computes its arrivals. Shared with the preview routes.
 * `failed` names the feeds that didn't answer; undefined when every feed failed.
 */
export async function loadArrivals(
  stop: ResolvedStop,
  idx: StationIndex,
  { fetcher, nowMs, limit }: { fetcher?: Fetcher; nowMs: number; limit: number },
): Promise<{ result: ArrivalsResult; failed: string[] } | undefined> {
  const names = feedsForRoutes(stop.routes);
  const settled = await Promise.allSettled(names.map((f) => fetchFeed(f, { fetcher, now: nowMs })));
  const feeds = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = names.filter((_, i) => settled[i]!.status === "rejected");
  for (const [i, s] of settled.entries()) {
    if (s.status === "rejected") console.error(`feed ${names[i]} failed:`, s.reason);
  }
  if (names.length > 0 && feeds.length === 0) return undefined;
  return { result: computeArrivals(stop, feeds, idx, { now: Math.floor(nowMs / 1000), limit }), failed };
}
