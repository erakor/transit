import { SUBWAY_DATA } from "../data/subway.generated.js";
import { json, NO_STORE } from "../http.js";

/** GET /health: no token, never cached. Says which static schedule is deployed. */
export function healthHandler() {
  return (_request: Request): Response =>
    json(
      { ok: true, staticFeedVersion: SUBWAY_DATA.feedVersion, time: Math.floor(Date.now() / 1000) },
      { cache: NO_STORE },
    );
}
