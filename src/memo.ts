/**
 * Fetching through a short in-memory memo, the capped body readers, and the helpers every provider's route shares. Imports only `errors.ts`'s
 * constants, so functions that don't decode GTFS-realtime feeds (PATH, Citi Bike) can use it without loading the protobuf bindings.
 */
import { FEED_MEMO_MS } from './errors.js'

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export interface FetchOptions {
  fetcher?: Fetcher
  /** Epoch milliseconds. */
  now?: number
  timeoutMs?: number
}

/**
 * Upstream answers kept in the function instance's memory for a few seconds. This sits behind
 * the CDN cache: it absorbs requests the CDN can't (cache misses for different stops in the
 * same window, concurrent misses) and coalesces concurrent fetches of the same feed.
 */
const MEMO_MS = FEED_MEMO_MS
/** How long a failed load is remembered: during an outage, requests fail at once instead of each waiting out the timeout. */
export const FAIL_MS = 5_000
const memo = new Map<string, { expiresAt: number; value: Promise<unknown> }>()

/**
 * `load()`, or its earlier result for `key` if it is under `ttlMs` old. A failed load is kept for `FAIL_MS` (or
 * `ttlMs` if shorter) counted from when it failed, not from when it started: a load that hangs until its 8 s timeout
 * would otherwise have used up the window before it rejects.
 */
export function memoized<T>(
  key: string,
  now: number,
  load: () => Promise<T>,
  ttlMs = MEMO_MS,
): Promise<T> {
  const hit = memo.get(key)
  if (hit && now < hit.expiresAt) return hit.value as Promise<T>
  // A miss is a good time to let go of feeds nobody asked for lately.
  for (const [k, entry] of memo) if (now >= entry.expiresAt) memo.delete(k)
  const started = Date.now()
  const value = load()
  const entry = { expiresAt: now + ttlMs, value }
  memo.set(key, entry)
  value.catch(() => {
    // `now` is the caller's clock (fixed in tests); the real time the load took moves it to the moment of failure.
    if (memo.get(key) === entry)
      entry.expiresAt = now + (Date.now() - started) + Math.min(ttlMs, FAIL_MS)
  })
  return value
}

/** Most bytes read from one upstream answer: the largest live feed is under 1 MB, so this is for a misbehaving upstream. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * The body of `res`, or a throw once it passes `maxBytes`: early on a `Content-Length` over the cap,
 * else while streaming (the header can be absent or wrong), cancelling the rest. The message never
 * names the request URL, which can carry a key.
 */
export async function readLimited(res: Response, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array> {
  const tooBig = () => new Error(`upstream body over ${maxBytes} bytes`)
  const declared = Number(res.headers.get('content-length'))
  if (declared > maxBytes) {
    await res.body?.cancel()
    throw tooBig()
  }
  if (!res.body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw tooBig()
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]!
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

const utf8 = new TextDecoder()

/** `readLimited()`, parsed as JSON: what `res.json()` was, with the size cap. */
export async function readLimitedJson(res: Response, maxBytes?: number): Promise<unknown> {
  return JSON.parse(utf8.decode(await readLimited(res, maxBytes)))
}

/** For tests. */
export function clearFeedMemo(): void {
  memo.clear()
}

/** `load()`, or undefined (logged under `label`) when it fails: for routes that answer 502 then. */
export async function tryLoad<T>(label: string, load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load()
  } catch (err) {
    console.error(`${label} failed:`, err)
    return undefined
  }
}
