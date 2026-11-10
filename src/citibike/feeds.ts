import { Memo } from "../memo.js";
import type { Fetcher } from "../subway/feeds.js";

const BASE = "https://gbfs.lyft.com/gbfs/2.3/bkn/en/";

/**
 * Citi Bike GBFS feeds (plain JSON, no key) and how long a function instance keeps each one.
 * `station_information` (names, positions) changes when stations are added or moved;
 * `station_status` (bikes and docks) is live, with an upstream ttl of 60 s. With `staleOnError`,
 * a failed refresh serves the last copy that loaded (up to `STALE_MAX_MS` old): stations rarely
 * change.
 */
export const GBFS_FEEDS: Record<"station_information" | "station_status", { memoMs: number; staleOnError: boolean }> = {
  station_information: { memoMs: 600_000, staleOnError: true },
  station_status: { memoMs: 15_000, staleOnError: false },
};
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

const memo = new Memo<GbfsFeed<unknown>>();
/** The last copy that loaded, per feed with `staleOnError`, and when it loaded. */
const lastGood = new Map<GbfsFeedName, { at: number; feed: GbfsFeed<unknown> }>();
/**
 * How long a previous copy may stand in for a failing feed. Past this the feed fails like any
 * other, so a feed that moved for good turns into 502s instead of a station list frozen for the
 * instance's lifetime.
 */
export const STALE_MAX_MS = 6 * 3_600_000;

export async function fetchGbfs<K extends GbfsFeedName>(
  feed: K,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {},
): Promise<GbfsStations[K]> {
  const { memoMs, staleOnError } = GBFS_FEEDS[feed];
  const loaded = memo.get(feed, { ttlMs: memoMs, now }, async () => {
    try {
      const res = await fetcher(gbfsUrl(feed), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`feed ${feed}: HTTP ${res.status}`);
      const parsed = parseGbfs<unknown>(feed, await res.json());
      if (staleOnError) lastGood.set(feed, { at: now, feed: parsed });
      return parsed;
    } catch (err) {
      const last = staleOnError ? lastGood.get(feed) : undefined;
      if (!last || now - last.at > STALE_MAX_MS) throw err;
      // Memoized like a fresh copy, so an outage costs one upstream attempt per memo window.
      console.error(`feed ${feed} failed, using the copy from ${Math.round((now - last.at) / 60_000)} min ago:`, err);
      return last.feed;
    }
  });
  return loaded as Promise<GbfsStations[K]>;
}

/** For tests. */
export function clearGbfsMemo(): void {
  memo.clear();
  lastGood.clear();
}
