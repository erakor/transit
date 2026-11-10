/**
 * Records the live MTA subway feeds into test/fixtures/<feed>.pb and the PATH feed into
 * test/fixtures/ridepath.json. Re-run `pnpm build:static` first if stops changed.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parsePathFeed, PATH_FEED_URL } from "../src/path/feed.js";
import { decodeFeed, FEEDS, feedUrl } from "../src/subway/feeds.js";

for (const feed of Object.keys(FEEDS)) {
  const res = await fetch(feedUrl(feed), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const msg = decodeFeed(bytes);
  const out = fileURLToPath(new URL(`../test/fixtures/${feed}.pb`, import.meta.url));
  await writeFile(out, bytes);
  console.log(`${feed}: ${bytes.length} bytes, ${msg.entity.length} entities, header ${msg.header.timestamp}`);
}
console.log("Update FIXTURE_NOW_MS in test/helpers.ts to the latest header timestamp above (in ms).");

const res = await fetch(PATH_FEED_URL, { signal: AbortSignal.timeout(15_000) });
if (!res.ok) throw new Error(`PATH: HTTP ${res.status}`);
const body = await res.text();
const trains = Object.values(parsePathFeed(JSON.parse(body)).stations).flat();
await writeFile(fileURLToPath(new URL("../test/fixtures/ridepath.json", import.meta.url)), body);
console.log(`ridepath.json: ${body.length} bytes, ${trains.length} trains, newest update ${Math.max(...trains.map((t) => t.updatedAt))}`);
console.log("Update PATH_FIXTURE_NOW_MS in test/helpers.ts to that newest update (in ms).");
