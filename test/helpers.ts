import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { AGENCIES } from "../src/agency/agencies.js";
import { clearFeedMemo, type Fetcher } from "../src/gtfsrt.js";

export const TOKEN = "test-token";
export const auth = { "x-transit-token": TOKEN };

/** What every route test needs: a server token, quiet error logs and an empty feed memo. */
export function useRouteTestSetup(): void {
  beforeEach(() => {
    vi.stubEnv("TRANSIT_TOKEN", TOKEN);
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearFeedMemo();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
}

/**
 * The fixture a feed URL is recorded under (without extension): its last path segment
 * ("nyct/gtfs-ace" -> gtfs-ace, "camsys/subway-alerts" -> subway-alerts), prefixed with the
 * agency id for an agency's own host (the ferry's "tripupdate" -> ferry-tripupdate).
 */
export function fixtureName(url: string): string {
  const name = decodeURIComponent(url).split("/").pop()!;
  const agency = Object.values(AGENCIES).find((a) => [a.tripsFeed, a.vehiclesFeed, a.alertsFeed].includes(url));
  return agency ? `${agency.id}-${name}` : name;
}

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
    const feed = fixtureName(url);
    calls.push(feed);
    if (fail.includes(feed)) return new Response("upstream down", { status: 503 });
    return new Response(fixture(feed.endsWith(".json") ? feed : `${feed}.pb`));
  };
  return Object.assign(f, { calls });
}

/** Newest header timestamp of the recorded GTFS-realtime feeds, so fixture tests see the trains as upcoming. */
export const FIXTURE_NOW_MS = 1794334736_000;

/** Newest `lastUpdated` in the recorded PATH feed (test/fixtures/ridepath.json). */
export const PATH_FIXTURE_NOW_MS = 1794334700_000;

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://transit.test${path}`, { headers });
}
