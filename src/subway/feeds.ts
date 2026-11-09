import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;
export type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";

/** MTA subway GTFS-realtime feeds (no API key needed) and the routes each one carries. */
export const FEEDS: Record<string, readonly string[]> = {
  "gtfs": ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "GS"],
  "gtfs-ace": ["A", "C", "E", "H"],
  "gtfs-bdfm": ["B", "D", "F", "FX", "M", "FS"],
  "gtfs-g": ["G"],
  "gtfs-jz": ["J", "Z"],
  "gtfs-nqrw": ["N", "Q", "R", "W"],
  "gtfs-l": ["L"],
  "gtfs-si": ["SI"],
};

export function feedUrl(feed: string): string {
  return BASE + feed;
}

const FEED_OF_ROUTE = new Map<string, string>();
for (const [feed, routes] of Object.entries(FEEDS)) for (const r of routes) FEED_OF_ROUTE.set(r, feed);

/** The feeds that carry any of `routes`, in FEEDS order. Unknown routes are ignored. */
export function feedsForRoutes(routes: Iterable<string>): string[] {
  const wanted = new Set<string>();
  for (const r of routes) {
    const f = FEED_OF_ROUTE.get(r);
    if (f) wanted.add(f);
  }
  return Object.keys(FEEDS).filter((f) => wanted.has(f));
}

export function decodeFeed(bytes: Uint8Array): FeedMessage {
  return transit_realtime.FeedMessage.decode(bytes);
}

/**
 * Fetched feeds kept in the function instance's memory for a few seconds. This sits behind
 * the CDN cache: it absorbs requests the CDN can't (cache misses for different stops in the
 * same window, concurrent misses) and coalesces concurrent fetches of the same feed.
 */
const MEMO_MS = 15_000;
const memo = new Map<string, { at: number; feed: Promise<FeedMessage> }>();

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchFeed(
  feed: string,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {},
): Promise<FeedMessage> {
  const hit = memo.get(feed);
  if (hit && now - hit.at < MEMO_MS) return hit.feed;
  const promise = (async () => {
    const res = await fetcher(feedUrl(feed), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`feed ${feed}: HTTP ${res.status}`);
    return decodeFeed(new Uint8Array(await res.arrayBuffer()));
  })();
  memo.set(feed, { at: now, feed: promise });
  promise.catch(() => {
    if (memo.get(feed)?.feed === promise) memo.delete(feed);
  });
  return promise;
}

/** For tests. */
export function clearFeedMemo(): void {
  memo.clear();
}
