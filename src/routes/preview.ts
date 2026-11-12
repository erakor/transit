import { authenticated, errorResponse, PREVIEW_CACHE, text } from "#src/http.js";
import { StopSearch } from "#src/stops/search.js";
import { stationIndex } from "#src/stops/stations.js";
import { previewLine } from "#src/subway/preview.js";
import { loadArrivals, type ArrivalsDeps } from "./arrivals.js";

/** Shorter windows when some feeds failed, so a full answer comes back soon. */
const PARTIAL_PREVIEW_CACHE = "public, max-age=5, s-maxage=5";

/**
 * GET /preview/subway?q=<station name> or ?stop=<id>: one plain-text line with the next train
 * per route and direction, for a launcher hint. `q` takes the top `/stops/search` result.
 * Errors are JSON like every other route; clients that show a line just ignore them.
 */
export function subwayPreviewHandler({ fetcher, now = () => Date.now(), index = stationIndex }: ArrivalsDeps = {}) {
  let search: StopSearch | undefined;
  return authenticated(async (_request, url) => {
    const q = url.searchParams.get("q")?.trim();
    const stopParam = url.searchParams.get("stop")?.trim();
    if (!q && !stopParam) return errorResponse(400, "q or stop is required");
    if (q && q.length > 100) return errorResponse(400, "q is too long");

    const idx = index();
    let stopId = stopParam;
    if (!stopId) {
      search ??= new StopSearch(idx.data);
      stopId = search.search(q!, 1)[0]?.id;
      if (!stopId) return errorResponse(404, "no matching station");
    }
    const stop = idx.resolve(stopId);
    if (!stop) return errorResponse(404, `unknown stop ${stopId}`);

    const nowMs = now();
    const loaded = await loadArrivals(stop, idx, { fetcher, nowMs, limit: 1 });
    if (!loaded) return errorResponse(502, "MTA feeds unavailable");
    return text(previewLine(loaded.result, Math.floor(nowMs / 1000)), {
      cache: loaded.failed.length ? PARTIAL_PREVIEW_CACHE : PREVIEW_CACHE,
    });
  });
}
