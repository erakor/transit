/**
 * Records the live feeds into test/fixtures.
 *
 *   pnpm record-fixtures            # every provider
 *   pnpm record-fixtures subway     # test/fixtures/<feed>.pb; re-run `pnpm build:static` first if stops changed
 *   pnpm record-fixtures citibike   # test/fixtures/citibike-<feed>.json
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fetchGbfs } from "../src/citibike/feeds.js";
import { distanceMeters } from "../src/citibike/stations.js";
import { decodeFeed, FEEDS, feedUrl } from "../src/subway/feeds.js";

const fixturePath = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

async function recordSubway(): Promise<void> {
  for (const feed of Object.keys(FEEDS)) {
    const res = await fetch(feedUrl(feed), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const msg = decodeFeed(bytes);
    await writeFile(fixturePath(`${feed}.pb`), bytes);
    console.log(`${feed}: ${bytes.length} bytes, ${msg.entity.length} entities, header ${msg.header.timestamp}`);
  }
  console.log("Update FIXTURE_NOW_MS in test/helpers.ts to the latest header timestamp above (in ms).");
}

/**
 * The full feeds are about 1 MB each, so the fixtures keep the stations around Times Sq,
 * untouched, in feed order. The tests don't depend on the clock.
 */
async function recordCitibike(): Promise<void> {
  const TIMES_SQ = { lat: 40.7559, lon: -73.9871 };
  const RADIUS_M = 800;
  const opts = { timeoutMs: 15_000 };
  const feeds = {
    station_information: await fetchGbfs("station_information", opts),
    station_status: await fetchGbfs("station_status", opts),
  };
  const keep = new Set(
    feeds.station_information.data.stations
      .filter((s) => distanceMeters(TIMES_SQ.lat, TIMES_SQ.lon, s.lat, s.lon) <= RADIUS_M)
      .map((s) => s.station_id),
  );
  for (const [name, feed] of Object.entries(feeds)) {
    const total = feed.data.stations.length;
    const kept = { ...feed, data: { ...feed.data, stations: feed.data.stations.filter((s) => keep.has(s.station_id)) } };
    await writeFile(fixturePath(`citibike-${name}.json`), JSON.stringify(kept, null, 1) + "\n");
    console.log(`citibike ${name}: kept ${kept.data.stations.length} of ${total} stations`);
  }
}

const recorders: Record<string, () => Promise<void>> = { subway: recordSubway, citibike: recordCitibike };
const only = process.argv[2];
if (only && !recorders[only]) throw new Error(`unknown provider ${only}: ${Object.keys(recorders).join(" or ")}`);
for (const [name, record] of Object.entries(recorders)) if (!only || only === name) await record();
