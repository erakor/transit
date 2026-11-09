/** Records the live MTA subway feeds into test/fixtures/<feed>.pb. Re-run `npm run build:static` first if stops changed. */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
