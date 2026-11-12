/** GTFS-realtime plumbing shared by every provider: fetching, decoding and reading feeds. */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'

const { transit_realtime } = GtfsRealtimeBindings
export type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/'

/**
 * URL of a GTFS-realtime feed: a subway feed name ("gtfs-ace"), another MTA feed with its group
 * ("lirr/gtfs-lirr", "camsys/subway-alerts"), or a full URL for other agencies.
 */
export function feedUrl(feed: string): string {
  if (feed.startsWith('https://')) return feed
  return MTA + encodeURIComponent(feed.includes('/') ? feed : `nyct/${feed}`)
}

export function decodeFeed(bytes: Uint8Array): FeedMessage {
  return transit_realtime.FeedMessage.decode(bytes)
}

/**
 * Upstream answers kept in the function instance's memory for a few seconds. This sits behind
 * the CDN cache: it absorbs requests the CDN can't (cache misses for different stops in the
 * same window, concurrent misses) and coalesces concurrent fetches of the same feed.
 */
const MEMO_MS = 15_000
const memo = new Map<string, { at: number; ttlMs: number; value: Promise<unknown> }>()

/** `load()`, or its earlier result for `key` if it is under `ttlMs` old. A failed load is not kept. */
export function memoized<T>(key: string, now: number, load: () => Promise<T>, ttlMs = MEMO_MS): Promise<T> {
  const hit = memo.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>
  // A miss is a good time to let go of feeds nobody asked for lately.
  for (const [k, entry] of memo) if (now - entry.at >= entry.ttlMs) memo.delete(k)
  const value = load()
  memo.set(key, { at: now, ttlMs, value })
  value.catch(() => {
    if (memo.get(key)?.value === value) memo.delete(key)
  })
  return value
}

/** For tests. */
export function clearFeedMemo(): void {
  memo.clear()
}

export interface FetchOptions {
  fetcher?: Fetcher
  /** Epoch milliseconds. */
  now?: number
  timeoutMs?: number
}

export function fetchFeed(
  feed: string,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: FetchOptions = {}
): Promise<FeedMessage> {
  return memoized(feed, now, async () => {
    const res = await fetcher(feedUrl(feed), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`feed ${feed}: HTTP ${res.status}`)
    return decodeFeed(new Uint8Array(await res.arrayBuffer()))
  })
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

/** `fetchFeed`, or undefined (logged) when the upstream fails: for routes that answer 502 then. */
export function tryFetchFeed(feed: string, options?: FetchOptions): Promise<FeedMessage | undefined> {
  return tryLoad(`feed ${feed}`, () => fetchFeed(feed, options))
}

type Long = { toNumber(): number }
/** A protobuf number: `int64` fields decode as `Long` objects. Unset and 0 read as undefined. */
export function num(v: number | Long | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : v.toNumber()
  return n > 0 ? n : undefined
}

/** Oldest header timestamp among `feeds` (epoch seconds), null when none has one. */
export function oldestTimestamp(feeds: FeedMessage[]): number | null {
  const stamps = feeds.map(f => num(f.header?.timestamp)).filter((t): t is number => t !== undefined)
  return stamps.length ? Math.min(...stamps) : null
}

/**
 * The trip's last stop with a known name. Feeds sometimes end a trip at a yard or
 * non-revenue track id that isn't in the static stops, so walk back to the last real one.
 */
export function terminalName(
  updates: { stopId?: string | null }[],
  stopName: (id: string) => string | undefined
): string {
  for (let i = updates.length - 1; i >= 0; i--) {
    const name = stopName(updates[i]!.stopId ?? '')
    if (name) return name
  }
  return ''
}

/** `VehiclePosition.current_status`, by enum value. */
export const VEHICLE_STATUS = ['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'] as const

/** Positions older than this are left out: the feeds keep finished trips around for hours. */
export const VEHICLE_MAX_AGE_S = 900

/** How a route is shown: every response that names a route carries these. */
export interface RouteDisplay {
  id: string
  name: string
  /** Hex color with leading "#". */
  color: string
  textColor: string
}

/** A route nobody has display data for shows under its id, in gray. */
export function fallbackRoute(id: string): RouteDisplay {
  return { id, name: id, color: '#808183', textColor: '#FFFFFF' }
}
