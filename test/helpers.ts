import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetcher } from "../src/subway/feeds.js";

export const TOKEN = "test-token";

export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

type FixtureName = (url: string) => { feed: string; file: string };
const mtaFixture: FixtureName = (url) => {
  const feed = decodeURIComponent(url).split("/").pop()!;
  return { feed, file: `${feed}.pb` };
};

/**
 * Serves fixtures (by default test/fixtures/<feed>.pb for MTA feed URLs) and records which feeds
 * were requested. Feeds in `fail`, which tests may change, answer 503.
 */
export function fixtureFetcher(fail: string[] = [], name: FixtureName = mtaFixture): Fetcher & { calls: string[]; fail: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    const { feed, file } = name(url);
    calls.push(feed);
    if (fail.includes(feed)) return new Response("upstream down", { status: 503 });
    return new Response(fixture(file));
  };
  return Object.assign(f, { calls, fail });
}

/** Header timestamp of the recorded feeds, so fixture tests see the trains as upcoming. */
export const FIXTURE_NOW_MS = 1794232814_000;

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://transit.test${path}`, { headers });
}

/** Serves test/fixtures/citibike-<feed>.json for Citi Bike GBFS URLs. */
export function citibikeFetcher(fail: string[] = []) {
  return fixtureFetcher(fail, (url) => {
    const feed = basename(url, ".json");
    return { feed, file: `citibike-${feed}.json` };
  });
}
