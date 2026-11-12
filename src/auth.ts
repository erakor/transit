import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Clients send the token as `X-Transit-Token: <token>`.
 *
 * Not `Authorization: Bearer`: Vercel's CDN never caches a response to a request that carries
 * an Authorization header, so every call would reach the function and the MTA. Responses to
 * authenticated routes carry `Vary: X-Transit-Token`, so the token is part of the CDN cache key
 * and a request with a missing or wrong token can never be served a cached 200.
 */
export const TOKEN_HEADER = 'x-transit-token'

export type AuthResult = { ok: true } | { ok: false; status: 401 | 500; error: string }

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/** Comma-separated so the token can be rotated: add the new one, update clients, drop the old. */
export function configuredTokens(env: Record<string, string | undefined> = process.env): string[] {
  return (env.TRANSIT_TOKEN ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
}

export function presentedToken(headers: Headers): string | undefined {
  return headers.get(TOKEN_HEADER)?.trim() || undefined
}

export function checkToken(headers: Headers, env: Record<string, string | undefined> = process.env): AuthResult {
  const tokens = configuredTokens(env)
  if (tokens.length === 0) return { ok: false, status: 500, error: 'server token not configured' }
  const given = presentedToken(headers)
  if (!given) return { ok: false, status: 401, error: 'missing token' }
  const g = digest(given)
  // Compare against every token so timing doesn't reveal which one matched.
  let ok = false
  for (const t of tokens) ok = timingSafeEqual(g, digest(t)) || ok
  return ok ? { ok: true } : { ok: false, status: 401, error: 'invalid token' }
}
