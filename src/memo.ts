/**
 * Fetching through a short in-memory memo, and the helpers every provider's route shares with it. No imports, so
 * functions that don't decode GTFS-realtime feeds (PATH, Citi Bike) can use it without loading the protobuf bindings.
 */

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
const MEMO_MS = 15_000
/** How long a failed load is remembered: during an outage, requests fail at once instead of each waiting out the timeout. */
export const FAIL_MS = 5_000
const memo = new Map<string, { at: number; ttlMs: number; value: Promise<unknown> }>()

/**
 * `load()`, or its earlier result for `key` if it is under `ttlMs` old. A failed load is kept for `FAIL_MS` (or
 * `ttlMs` if shorter), so callers in that window get the same rejection without another attempt.
 */
export function memoized<T>(key: string, now: number, load: () => Promise<T>, ttlMs = MEMO_MS): Promise<T> {
  const hit = memo.get(key)
  if (hit && now - hit.at < hit.ttlMs) return hit.value as Promise<T>
  // A miss is a good time to let go of feeds nobody asked for lately.
  for (const [k, entry] of memo) if (now - entry.at >= entry.ttlMs) memo.delete(k)
  const value = load()
  const entry = { at: now, ttlMs, value }
  memo.set(key, entry)
  value.catch(() => {
    if (memo.get(key) === entry) entry.ttlMs = Math.min(ttlMs, FAIL_MS)
  })
  return value
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
