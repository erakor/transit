import { authenticated, errorResponse, intParam, json, LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE, text } from "../http.js";
import { computePathArrivals } from "../path/arrivals.js";
import { fetchPathFeed, type PathFeed } from "../path/feed.js";
import { pathPreviewLine } from "../path/preview.js";
import { PATH_STATIONS, pathStation, routesOf, searchPathStations } from "../path/stations.js";
import type { Fetcher } from "../subway/feeds.js";

export interface PathDeps {
  fetcher?: Fetcher;
  now?: () => number;
}

async function loadFeed(fetcher: Fetcher | undefined, nowMs: number): Promise<PathFeed | undefined> {
  try {
    return await fetchPathFeed({ fetcher, now: nowMs });
  } catch (err) {
    console.error("PATH feed failed:", err);
    return undefined;
  }
}

/** GET /path/arrivals?station=<id>&limit=<per route and direction, default 3, max 10> */
export function pathArrivalsHandler({ fetcher, now = () => Date.now() }: PathDeps = {}) {
  return authenticated(async (_request, url) => {
    const stationParam = url.searchParams.get("station")?.trim();
    if (!stationParam) return errorResponse(400, "station is required");
    const limit = intParam(url, "limit", 3, 10);
    if (typeof limit !== "number") return errorResponse(400, limit.error);
    const station = pathStation(stationParam);
    if (!station) return errorResponse(404, `unknown station ${stationParam}`);

    const nowMs = now();
    const feed = await loadFeed(fetcher, nowMs);
    if (!feed) return errorResponse(502, "PATH feed unavailable");
    return json(computePathArrivals(station, feed, { now: Math.floor(nowMs / 1000), limit }), { cache: LIVE_CACHE });
  });
}

/** GET /path/stations: the 13 stations with the routes serving them. */
export function pathStationsHandler() {
  return authenticated(() =>
    json(
      { stations: PATH_STATIONS.map((s) => ({ id: s.id, name: s.name, routes: routesOf(s) })) },
      { cache: STATIC_CACHE },
    ),
  );
}

/**
 * GET /preview/path?q=<station name> or ?station=<id>: one plain-text line with the next train
 * to each destination, for a launcher hint. Errors are JSON like every other route.
 */
export function pathPreviewHandler({ fetcher, now = () => Date.now() }: PathDeps = {}) {
  return authenticated(async (_request, url) => {
    const q = url.searchParams.get("q")?.trim();
    const stationParam = url.searchParams.get("station")?.trim();
    if (!q && !stationParam) return errorResponse(400, "q or station is required");
    if (q && q.length > 100) return errorResponse(400, "q is too long");

    const station = stationParam ? pathStation(stationParam) : searchPathStations(q!)[0];
    if (!station) return errorResponse(404, stationParam ? `unknown station ${stationParam}` : "no matching station");

    const nowMs = now();
    const feed = await loadFeed(fetcher, nowMs);
    if (!feed) return errorResponse(502, "PATH feed unavailable");
    const nowS = Math.floor(nowMs / 1000);
    return text(pathPreviewLine(computePathArrivals(station, feed, { now: nowS, limit: 1 }), nowS), { cache: PREVIEW_CACHE });
  });
}
