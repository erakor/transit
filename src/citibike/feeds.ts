import type { Fetcher } from "../subway/feeds.js";

const BASE = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/";

/**
 * Citi Bike GBFS feeds (plain JSON, no key) and how long a function instance keeps each one.
 * `station_information` (names, positions) changes when stations are added or moved;
 * `station_status` (bikes and docks) is live, with an upstream ttl of 60 s.
 */
export const GBFS_FEEDS = {
  station_information: { memoMs: 600_000 },
  station_status: { memoMs: 15_000 },
} as const;
export type GbfsFeedName = keyof typeof GBFS_FEEDS;

export function gbfsUrl(feed: GbfsFeedName): string {
  return `${BASE}${feed}.json`;
}

/** One station of `station_information`. Fields this service doesn't use are left out. */
export interface GbfsStationInformation {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
  capacity?: number;
}

/** One station of `station_status`. */
export interface GbfsStationStatus {
  station_id: string;
  /** Every rentable bike, e-bikes included. */
  num_bikes_available?: number;
  num_ebikes_available?: number;
  num_docks_available?: number;
  is_installed?: number | boolean;
  is_renting?: number | boolean;
  is_returning?: number | boolean;
  last_reported?: number;
}

export interface GbfsFeed<T> {
  last_updated: number;
  ttl?: number;
  data: { stations: T[] };
}
interface GbfsStations {
  station_information: GbfsFeed<GbfsStationInformation>;
  station_status: GbfsFeed<GbfsStationStatus>;
}

/** Checks the envelope, so a changed or truncated feed fails here instead of deep in a handler. */
export function parseGbfs<T>(feed: string, body: unknown): GbfsFeed<T> {
  const b = body as Partial<GbfsFeed<T>> | null;
  if (!b || typeof b.last_updated !== "number" || !Array.isArray(b.data?.stations)) {
    throw new Error(`feed ${feed}: not a GBFS station feed`);
  }
  return b as GbfsFeed<T>;
}

/** Like the subway feed memo: sits behind the CDN cache and coalesces concurrent fetches. */
const memo = new Map<string, { at: number; feed: Promise<GbfsFeed<unknown>> }>();
/** The last station list that loaded, served when a refresh fails: stations rarely change. */
let lastInformation: GbfsFeed<GbfsStationInformation> | undefined;

export async function fetchGbfs<K extends GbfsFeedName>(
  feed: K,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {},
): Promise<GbfsStations[K]> {
  const hit = memo.get(feed);
  if (hit && now - hit.at < GBFS_FEEDS[feed].memoMs) return hit.feed as Promise<GbfsStations[K]>;
  const promise = (async () => {
    try {
      const res = await fetcher(gbfsUrl(feed), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`feed ${feed}: HTTP ${res.status}`);
      const parsed = parseGbfs<unknown>(feed, await res.json());
      if (feed === "station_information") lastInformation = parsed as GbfsFeed<GbfsStationInformation>;
      return parsed;
    } catch (err) {
      if (feed !== "station_information" || !lastInformation) throw err;
      console.error(`feed ${feed} failed, using the previous copy:`, err);
      // Not memoized as fresh: the entry is dropped below so the next request retries.
      queueMicrotask(() => {
        if (memo.get(feed)?.feed === promise) memo.delete(feed);
      });
      return lastInformation;
    }
  })();
  memo.set(feed, { at: now, feed: promise });
  promise.catch(() => {
    if (memo.get(feed)?.feed === promise) memo.delete(feed);
  });
  return promise as Promise<GbfsStations[K]>;
}

/** For tests. */
export function clearGbfsMemo(): void {
  memo.clear();
  lastInformation = undefined;
}
