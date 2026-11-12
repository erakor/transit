import { checkToken, TOKEN_HEADER } from "./auth.js";

/** Live data: the CDN serves a copy for 20 s, then a stale one for up to 40 s while it refreshes. */
export const LIVE_CACHE = "public, s-maxage=20, stale-while-revalidate=40";
/**
 * Data that only changes with a deploy (Vercel purges the CDN cache on each production deploy).
 */
export const STATIC_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";
/** Service alerts: they change by the minute at most, and the feeds are the largest we read. */
export const ALERTS_CACHE = "public, s-maxage=60, stale-while-revalidate=120";
export const NO_STORE = "no-store";
/**
 * Preview lines for clients that show one line of text (the alfresco launcher's hint). Like
 * `LIVE_CACHE`, plus `max-age` so the client knows how long its own copy stays good.
 */
export const PREVIEW_CACHE = "public, max-age=20, s-maxage=20, stale-while-revalidate=40";

export function json(body: unknown, { status = 200, cache = NO_STORE, vary }: { status?: number; cache?: string; vary?: string } = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": cache,
  });
  if (vary) headers.set("vary", vary);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * One line of plain text, newline-terminated. Clients read the first non-empty line and ignore
 * answers that start with `<` (HTML), so the line is trimmed and must not be empty.
 */
export function text(line: string, { status = 200, cache = NO_STORE }: { status?: number; cache?: string } = {}): Response {
  const body = line.replace(/\s+/g, " ").trim();
  if (!body || body.startsWith("<")) throw new Error("a preview line must be non-empty text");
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cache },
  });
}

export function errorResponse(status: number, error: string, vary?: string): Response {
  return json({ error }, { status, cache: NO_STORE, vary });
}

/**
 * Wraps a handler that needs the client token. Successful responses vary on the token header
 * so the CDN keys cached copies by token; errors are never cached.
 */
export function authenticated(handler: (request: Request, url: URL) => Promise<Response> | Response) {
  return async (request: Request): Promise<Response> => {
    const auth = checkToken(request.headers);
    if (!auth.ok) {
      if (auth.status === 500) console.error("TRANSIT_TOKEN is not set");
      return errorResponse(auth.status, auth.error, TOKEN_HEADER);
    }
    let res: Response;
    try {
      res = await handler(request, new URL(request.url));
    } catch (err) {
      console.error(err);
      res = errorResponse(500, "internal error");
    }
    const vary = res.headers.get("vary");
    res.headers.set("vary", vary ? `${vary}, ${TOKEN_HEADER}` : TOKEN_HEADER);
    return res;
  };
}

/**
 * Parses an optional positive integer query parameter, clamped to [1, max]. Routes with schemas
 * use `countParam()` in `schema.ts` instead, which follows the same rule; delete this once every
 * route has moved over.
 */
export function intParam(url: URL, name: string, fallback: number, max: number): number | { error: string } {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return { error: `${name} must be a positive integer` };
  return Math.min(Number(raw), max);
}
