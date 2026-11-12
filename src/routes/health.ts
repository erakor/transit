import { SUBWAY_DATA } from "#src/data/subway.generated.js";
import { json, NO_STORE } from "#src/http.js";

/** GET /health: no token, never cached. Says which static schedule is deployed. */
export function healthHandler() {
  return (_request: Request): Response =>
    json(
      { ok: true, staticFeedVersion: SUBWAY_DATA.feedVersion, time: Math.floor(Date.now() / 1000) },
      { cache: NO_STORE },
    );
}
