/** Stable, machine-readable error codes and the HTTP status each goes with. */
export const ERROR_STATUS = {
  invalid_parameter: 400,
  missing_token: 401,
  invalid_token: 401,
  unknown_stop: 404,
  unknown_station: 404,
  unknown_route: 404,
  not_found: 404,
  internal_error: 500,
  upstream_unavailable: 502,
  not_configured: 503,
} as const
/** How long the instance keeps an upstream answer; a 502 tells clients to retry after about that long. */
export const FEED_MEMO_MS = 15_000

/** Headers an error code carries besides the body. A 503 `not_configured` has no `Retry-After`: it won't clear by itself. */
export const ERROR_HEADERS: Partial<Record<keyof typeof ERROR_STATUS, Record<string, string>>> = {
  missing_token: { 'www-authenticate': 'x-transit-token' },
  invalid_token: { 'www-authenticate': 'x-transit-token' },
  upstream_unavailable: { 'retry-after': String(FEED_MEMO_MS / 1000) },
}
export type ErrorCode = keyof typeof ERROR_STATUS
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]
