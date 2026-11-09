import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fetcher } from "../src/subway/feeds.js";

export const TOKEN = "test-token";

export function fixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

/** Serves test/fixtures/<feed>.pb for MTA feed URLs and records which feeds were requested. */
export function fixtureFetcher(fail: string[] = []): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    const feed = decodeURIComponent(url).split("/").pop()!;
    calls.push(feed);
    if (fail.includes(feed)) return new Response("upstream down", { status: 503 });
    return new Response(fixture(`${feed}.pb`));
  };
  return Object.assign(f, { calls });
}

/** Header timestamp of the recorded feeds, so fixture tests see the trains as upcoming. */
export const FIXTURE_NOW_MS = 1794232814_000;

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://transit.test${path}`, { headers });
}
