/**
 * Records the live feeds into test/fixtures: every GTFS-realtime feed as <name>.pb (named by
 * `fixtureName`, which the tests' fetcher uses too) and the PATH feed as ridepath.json. Alert
 * feeds are cut down to the alerts in effect when recorded (the full subway one is half a
 * megabyte of future planned work). Re-run `pnpm build:static` first if stops changed.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { AGENCIES } from "../src/agency/agencies.js";
import { inEffect } from "../src/alerts.js";
import { decodeFeed, feedUrl } from "../src/gtfsrt.js";
import { parsePathFeed, PATH_FEED_URL } from "../src/path/feed.js";
import { BUS_ALERTS_FEED } from "../src/routes/agency.js";
import { SUBWAY_ALERTS_FEED } from "../src/routes/alerts.js";
import { FEEDS } from "../src/subway/feeds.js";
import { fixtureName } from "../test/helpers.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const out = (file: string) => fileURLToPath(new URL(`../test/fixtures/${file}`, import.meta.url));
const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
};

const agencies = Object.values(AGENCIES);
const feeds = [...Object.keys(FEEDS), ...agencies.flatMap((a) => [a.tripsFeed, ...(a.vehiclesFeed ? [a.vehiclesFeed] : [])])];
const alertFeeds = new Set([SUBWAY_ALERTS_FEED, BUS_ALERTS_FEED, ...agencies.map((a) => a.alertsFeed)]);

// All at once, so the recordings share one clock.
const recorded = await Promise.all(
  [...feeds, ...alertFeeds].map(async (feed) => {
    const url = feedUrl(feed);
    return { feed, name: fixtureName(url), bytes: new Uint8Array(await (await get(url)).arrayBuffer()) as Uint8Array };
  }),
);

let newest = 0;
for (const r of recorded) {
  const msg = decodeFeed(r.bytes);
  const stamp = Number(msg.header.timestamp ?? 0);
  if (alertFeeds.has(r.feed)) {
    const all = msg.entity.length;
    // An alert without periods is always in effect; one with periods keeps those covering now.
    msg.entity = msg.entity.filter((e) => {
      const periods = e.alert?.activePeriod ?? [];
      if (e.alert && periods.length) e.alert.activePeriod = periods.filter((p) => inEffect(p, stamp));
      return periods.length === 0 || e.alert!.activePeriod!.length > 0;
    });
    r.bytes = FeedMessage.encode(msg).finish();
    console.log(`${r.name}: kept ${msg.entity.length} of ${all} alerts`);
  } else {
    newest = Math.max(newest, stamp);
  }
  await writeFile(out(`${r.name}.pb`), r.bytes);
  console.log(`${r.name}: ${r.bytes.length} bytes, ${msg.entity.length} entities, header ${stamp}`);
}
console.log(`Update FIXTURE_NOW_MS in test/helpers.ts to the newest header timestamp: ${newest}_000.`);

const body = await (await get(PATH_FEED_URL)).text();
const trains = Object.values(parsePathFeed(JSON.parse(body)).stations).flat();
await writeFile(out("ridepath.json"), body);
console.log(`ridepath.json: ${body.length} bytes, ${trains.length} trains`);
console.log(`Update PATH_FIXTURE_NOW_MS in test/helpers.ts to the newest update: ${Math.max(...trains.map((t) => t.updatedAt))}_000.`);
