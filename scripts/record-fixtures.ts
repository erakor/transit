/**
 * Records the live feeds into test/fixtures: the MTA subway feeds as <feed>.pb, the other
 * GTFS-realtime feeds below, and the PATH feed as ridepath.json. Alert feeds are cut down to the
 * alerts in effect when recorded (the full subway one is half a megabyte of future planned
 * work). Re-run `pnpm build:static` first if stops changed.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { AGENCIES } from "../src/agency/agencies.js";
import { parsePathFeed, PATH_FEED_URL } from "../src/path/feed.js";
import { BUS_ALERTS_FEED, SUBWAY_ALERTS_FEED } from "../src/routes/alerts.js";
import { decodeFeed, FEEDS, feedUrl } from "../src/subway/feeds.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const out = (file: string) => fileURLToPath(new URL(`../test/fixtures/${file}`, import.meta.url));

/** File name (as `fixtureFetcher` in test/helpers.ts expects it), feed, and whether it is an alerts feed. */
const feeds: [file: string, feed: string, alerts?: boolean][] = [
  ...Object.keys(FEEDS).map((f): [string, string] => [f, f]),
  ["subway-alerts", SUBWAY_ALERTS_FEED, true],
  ["bus-alerts", BUS_ALERTS_FEED, true],
  ["gtfs-lirr", AGENCIES.lirr!.tripsFeed],
  ["lirr-alerts", AGENCIES.lirr!.alertsFeed, true],
  ["gtfs-mnr", AGENCIES.mnr!.tripsFeed],
  ["mnr-alerts", AGENCIES.mnr!.alertsFeed, true],
  ["ferry-tripupdate", AGENCIES.ferry!.tripsFeed],
  ["ferry-vehicleposition", AGENCIES.ferry!.vehiclesFeed!],
  ["ferry-alert", AGENCIES.ferry!.alertsFeed, true],
];

let newest = 0;
for (const [file, feed, alerts] of feeds) {
  const res = await fetch(feedUrl(feed), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  const msg = decodeFeed(bytes);
  const stamp = Number(msg.header.timestamp ?? 0);
  if (alerts) {
    const all = msg.entity.length;
    msg.entity = msg.entity.filter((e) => {
      const periods = e.alert?.activePeriod ?? [];
      return periods.length === 0 || periods.some((p) => Number(p.start ?? 0) <= stamp && (!Number(p.end ?? 0) || Number(p.end) >= stamp));
    });
    for (const e of msg.entity) e.alert!.activePeriod = (e.alert!.activePeriod ?? []).filter((p) => Number(p.start ?? 0) <= stamp && (!Number(p.end ?? 0) || Number(p.end) >= stamp));
    bytes = FeedMessage.encode(msg).finish();
    console.log(`${file}: kept ${msg.entity.length} of ${all} alerts`);
  } else {
    newest = Math.max(newest, stamp);
  }
  await writeFile(out(`${file}.pb`), bytes);
  console.log(`${file}: ${bytes.length} bytes, ${msg.entity.length} entities, header ${stamp}`);
}
console.log(`Update FIXTURE_NOW_MS in test/helpers.ts to the newest header timestamp: ${newest}_000.`);

const res = await fetch(PATH_FEED_URL, { signal: AbortSignal.timeout(15_000) });
if (!res.ok) throw new Error(`PATH: HTTP ${res.status}`);
const body = await res.text();
const trains = Object.values(parsePathFeed(JSON.parse(body)).stations).flat();
await writeFile(out("ridepath.json"), body);
console.log(`ridepath.json: ${body.length} bytes, ${trains.length} trains`);
console.log(`Update PATH_FIXTURE_NOW_MS in test/helpers.ts to the newest update: ${Math.max(...trains.map((t) => t.updatedAt))}_000.`);
