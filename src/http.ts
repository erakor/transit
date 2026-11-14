import { checkToken, TOKEN_HEADER } from './auth.js'
import { ERROR_HEADERS, ERROR_STATUS, type ErrorCode } from './errors.js'

/** Live data: the CDN serves a copy for 20 s, then a stale one for up to 40 s while it refreshes. */
export const LIVE_CACHE = 'public, s-maxage=20, stale-while-revalidate=40'
/**
 * Data that only changes with a deploy (Vercel purges the CDN cache on each production deploy).
 */
export const STATIC_CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400'
/** Lookups of upstream reference data that changes rarely but without a deploy (bus stops near a point). */
export const LOOKUP_CACHE = 'public, s-maxage=600, stale-while-revalidate=3600'
/** Service alerts: they change by the minute at most, and the feeds are the largest we read. */
export const ALERTS_CACHE = 'public, s-maxage=60, stale-while-revalidate=120'
export const NO_STORE = 'no-store'
/**
 * Preview lines for clients that show one line of text (the alfresco launcher's hint). Like
 * `LIVE_CACHE`, plus `max-age` so the client knows how long its own copy stays good.
 */
export const PREVIEW_CACHE = 'public, max-age=20, s-maxage=20, stale-while-revalidate=40'

export function json(
  body: unknown,
  { status = 200, cache = NO_STORE, vary }: { status?: number; cache?: string; vary?: string } = {}
): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
  })
  if (vary) headers.set('vary', vary)
  return new Response(JSON.stringify(body), { status, headers })
}

/**
 * One line of plain text, newline-terminated. Clients read the first non-empty line and ignore
 * answers that start with `<` (HTML), so the line is trimmed and must not be empty.
 */
export function text(
  line: string,
  { status = 200, cache = NO_STORE }: { status?: number; cache?: string } = {}
): Response {
  const body = line.replace(/\s+/g, ' ').trim()
  if (!body || body.startsWith('<')) throw new Error('a preview line must be non-empty text')
  return new Response(body + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cache },
  })
}

export function errorResponse(code: ErrorCode, error: string, vary?: string): Response {
  const status = ERROR_STATUS[code]
  const res = json({ error, code }, { status, cache: NO_STORE, vary })
  for (const [name, value] of Object.entries(ERROR_HEADERS[code] ?? {})) res.headers.set(name, value)
  return res
}

/**
 * Wraps a handler that needs the client token. Successful responses vary on the token header
 * so the CDN keys cached copies by token; errors are never cached.
 */
export function authenticated(handler: (request: Request, url: URL) => Promise<Response> | Response) {
  return async (request: Request): Promise<Response> => {
    const auth = checkToken(request.headers)
    if (!auth.ok) {
      if (auth.code === 'not_configured') console.error('TRANSIT_TOKEN is not set')
      return errorResponse(auth.code, auth.error, TOKEN_HEADER)
    }
    let res: Response
    try {
      res = await handler(request, new URL(request.url))
    } catch (err) {
      console.error(err)
      res = errorResponse('internal_error', 'internal error')
    }
    const vary = res.headers.get('vary')
    res.headers.set('vary', vary ? `${vary}, ${TOKEN_HEADER}` : TOKEN_HEADER)
    return res
  }
}

/**
 * The operation of a request to a function that serves several routes: `/<provider>/<op>` or
 * `/preview/<provider>` (`preview`) in the public path or, failing that, the `op` query parameter
 * that `vercel.json` adds (`/api/<provider>?op=<op>`), so it works whichever of the two URLs the
 * platform hands it (and in tests, the public one).
 */
export function providerOp(url: URL, provider: string): string | undefined {
  if (url.pathname.replace(/\/$/, '') === `/preview/${provider}`) return 'preview'
  const path = new RegExp(`^/${provider}/([a-z]+)/?$`).exec(url.pathname)
  return path?.[1] ?? url.searchParams.get('op') ?? undefined
}

type Handler = (request: Request) => Promise<Response>

/**
 * One function for several routes of a provider (a deployment has a limited number of functions,
 * see AGENTS.md), by operation. Each handler checks the token itself; an unknown operation is a
 * 404 behind the token check too.
 */
export function byOp(provider: string, ops: Record<string, Handler>): Handler {
  const notFound = authenticated(() => errorResponse('not_found', 'not found'))
  return request => {
    const op = providerOp(new URL(request.url), provider)
    return (op && Object.hasOwn(ops, op) ? ops[op]! : notFound)(request)
  }
}
