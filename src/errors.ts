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
export type ErrorCode = keyof typeof ERROR_STATUS
export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]
