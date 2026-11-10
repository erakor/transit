import type { Fetcher } from "../subway/feeds.js";
import { colorsKey } from "./stations.js";

/**
 * The Port Authority's real-time feed, the one behind the arrival boards on panynj.gov: one JSON
 * document with every station's next trains, refreshed about once a minute. No API key.
 */
export const PATH_FEED_URL = "https://www.panynj.gov/bin/portauthority/ridepath.json";

export interface PathTrain {
  /** "NY" for the feed's `ToNY` (toward Manhattan), "NJ" for `ToNJ`. */
  direction: "NY" | "NJ";
  headsign: string;
  /** Line color key, see `colorsKey`. */
  colors: string;
  /** Epoch seconds. */
  time: number;
  /** When the upstream computed `time` (epoch seconds). */
  updatedAt: number;
}

export interface PathFeed {
  /** Trains by station code, in feed order. A station with no trains has an empty list. */
  stations: Record<string, PathTrain[]>;
  /** Entries left out because they didn't have the expected shape. The smoke test wants 0. */
  skipped: number;
}

const DIRECTIONS: Record<string, PathTrain["direction"]> = { ToNY: "NY", ToNJ: "NJ" };

const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];

/**
 * Normalizes the feed. Each message gives `secondsToArrival` counted from its own `lastUpdated`
 * (the document itself can be a minute or two older than the request), so the arrival time is
 * their sum. Throws when the document isn't the feed at all; odd entries are counted and skipped.
 */
export function parsePathFeed(doc: unknown): PathFeed {
  const results = (doc as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error("PATH feed: no results array");
  const feed: PathFeed = { stations: {}, skipped: 0 };
  for (const result of list(results)) {
    const code = result.consideredStation;
    if (typeof code !== "string" || !code) {
      feed.skipped++;
      continue;
    }
    const trains = (feed.stations[code.toUpperCase()] ??= []);
    for (const destination of list(result.destinations)) {
      const direction = DIRECTIONS[String(destination.label)];
      for (const m of list(destination.messages)) {
        const seconds = typeof m.secondsToArrival === "string" || typeof m.secondsToArrival === "number" ? Number(m.secondsToArrival) : NaN;
        const updatedMs = typeof m.lastUpdated === "string" ? Date.parse(m.lastUpdated) : NaN;
        if (!direction || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(updatedMs)) {
          feed.skipped++;
          continue;
        }
        const updatedAt = Math.floor(updatedMs / 1000);
        trains.push({
          direction,
          headsign: typeof m.headSign === "string" ? m.headSign.trim() : "",
          colors: colorsKey(typeof m.lineColor === "string" ? m.lineColor : ""),
          time: updatedAt + Math.round(seconds),
          updatedAt,
        });
      }
    }
  }
  return feed;
}

/** Same in-function window as the subway feeds: one upstream request serves every station. */
const MEMO_MS = 15_000;
let memo: { at: number; feed: Promise<PathFeed> } | undefined;

export async function fetchPathFeed(
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {},
): Promise<PathFeed> {
  if (memo && now - memo.at < MEMO_MS) return memo.feed;
  const promise = (async () => {
    const res = await fetcher(PATH_FEED_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`PATH feed: HTTP ${res.status}`);
    return parsePathFeed(await res.json());
  })();
  memo = { at: now, feed: promise };
  promise.catch(() => {
    if (memo?.feed === promise) memo = undefined;
  });
  return promise;
}

/** For tests. */
export function clearPathFeedMemo(): void {
  memo = undefined;
}
