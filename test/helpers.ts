import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fetcher } from "../src/subway/feeds.js";

export const TOKEN = "test-token";

export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

/**
 * Serves test/fixtures/<feed>.pb for GTFS-realtime feed URLs and test/fixtures/ridepath.json for
 * the PATH feed, and records which feeds were requested.
 */
export function fixtureFetcher(fail: string[] = []): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    // "nyct/gtfs-ace" -> gtfs-ace, "camsys/subway-alerts" -> subway-alerts, the ferry's "tripupdate" -> ferry-tripupdate.
    const feed = (url.includes("nycferry") ? "ferry-" : "") + decodeURIComponent(url).split("/").pop()!;
    calls.push(feed);
    if (fail.includes(feed)) return new Response("upstream down", { status: 503 });
    return new Response(fixture(feed.endsWith(".json") ? feed : `${feed}.pb`));
  };
  return Object.assign(f, { calls });
}

/** Newest header timestamp of the recorded GTFS-realtime feeds, so fixture tests see the trains as upcoming. */
export const FIXTURE_NOW_MS = 1794322789_000;

/** Newest `lastUpdated` in the recorded PATH feed (test/fixtures/ridepath.json). */
export const PATH_FIXTURE_NOW_MS = 1794322744_000;

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://transit.test${path}`, { headers });
}
