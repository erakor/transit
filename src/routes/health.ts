import { SUBWAY_FEED_VERSION } from '#src/data/subway.version.generated.js'
import { json, NO_STORE } from '#src/http.js'
import type { HealthResponse } from '#src/schema.js'

/** GET /health: no token, never cached. Says which static schedule is deployed. */
export function healthHandler() {
  return (_request: Request): Response => {
    const body: HealthResponse = {
      ok: true,
      staticFeedVersion: SUBWAY_FEED_VERSION,
      time: Math.floor(Date.now() / 1000),
    }
    return json(body, { cache: NO_STORE })
  }
}
