/**
 * Records the live feeds into test/fixtures.
 *
 *   pnpm record-fixtures            # everything
 *   pnpm record-fixtures subway     # test/fixtures/<feed>.pb; re-run `pnpm build:static` first if stops changed
 *   pnpm record-fixtures citibike   # test/fixtures/citibike-<feed>.json
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GBFS_FEEDS, gbfsUrl, parseGbfs, type GbfsFeedName } from "../src/citibike/feeds.js";
import { distanceMeters } from "../src/citibike/stations.js";
import { decodeFeed, FEEDS, feedUrl } from "../src/subway/feeds.js";

const only = process.argv[2];
if (only && only !== "subway" && only !== "citibike") throw new Error(`unknown provider ${only}: subway or citibike`);
const fixturePath = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

if (only !== "citibike") {
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

if (only !== "subway") {
  // The full feeds are about 1 MB each, so the fixtures keep the stations around Times Sq,
  // untouched, in feed order. The tests don't depend on the clock.
  const CENTER = { lat: 40.7559, lon: -73.9871 };
  const RADIUS_M = 800;
  type Station = { station_id: string; lat?: number; lon?: number };
  const feeds = {} as Record<GbfsFeedName, { data: { stations: Station[] } }>;
  for (const feed of Object.keys(GBFS_FEEDS) as GbfsFeedName[]) {
    const res = await fetch(gbfsUrl(feed), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
    feeds[feed] = parseGbfs<Station>(feed, await res.json());
  }
  const keep = new Set(
    feeds.station_information.data.stations
      .filter((s) => distanceMeters(CENTER.lat, CENTER.lon, s.lat ?? 0, s.lon ?? 0) <= RADIUS_M)
      .map((s) => s.station_id),
  );
  for (const [name, feed] of Object.entries(feeds)) {
    const total = feed.data.stations.length;
    feed.data.stations = feed.data.stations.filter((s) => keep.has(s.station_id));
    await writeFile(fixturePath(`citibike-${name}.json`), JSON.stringify(feed, null, 1) + "\n");
    console.log(`citibike ${name}: kept ${feed.data.stations.length} of ${total} stations`);
  }
}
