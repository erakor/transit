/**
 * Smoke test against the live MTA and PATH feeds (and, optionally, a deployment).
 *
 *   pnpm smoke
 *   TRANSIT_BASE_URL=https://<deployment> TRANSIT_TOKEN=... pnpm smoke
 *
 * Fails when an upstream change would break the service: a feed that no longer decodes, stale
 * data, routes the FEEDS table doesn't know, stop ids missing from the static data, or a big
 * station with no arrivals. For PATH: entries the parser can't read, stations or line colors it
 * doesn't know, stale data, or Journal Square with no trains.
 */
import { computePathArrivals } from "../src/path/arrivals.js";
import { fetchPathFeed } from "../src/path/feed.js";
import { PATH_STATIONS, pathStation, routeForColors } from "../src/path/stations.js";
import { stationIndex } from "../src/stops/stations.js";
import { computeArrivals } from "../src/subway/arrivals.js";
import { fetchFeed, FEEDS, type FeedMessage } from "../src/subway/feeds.js";

const problems: string[] = [];
const fail = (msg: string) => {
  problems.push(msg);
  console.error(`FAIL ${msg}`);
};
const nowS = Math.floor(Date.now() / 1000);
const index = stationIndex();

const feeds: Record<string, FeedMessage> = {};
for (const name of Object.keys(FEEDS)) {
  try {
    feeds[name] = await fetchFeed(name, { timeoutMs: 20_000 });
  } catch (err) {
    fail(`${name}: ${(err as Error).message}`);
    continue;
  }
  const feed = feeds[name]!;
  const ts = Number(feed.header.timestamp ?? 0);
  const trips = feed.entity.filter((e) => e.tripUpdate);
  const routes = new Set(trips.map((e) => e.tripUpdate!.trip?.routeId ?? ""));
  const stopIds = trips.flatMap((e) => (e.tripUpdate!.stopTimeUpdate ?? []).map((s) => s.stopId ?? ""));
  const unknownStops = stopIds.filter((s) => !index.stopName(s));
  const unknownRoutes = [...routes].filter((r) => !FEEDS[name]!.includes(r));

  console.log(
    `${name}: ${trips.length} trips, routes ${[...routes].sort().join(",")}, age ${nowS - ts}s, ` +
      `${unknownStops.length}/${stopIds.length} stop updates with unknown stop ids`,
  );
  if (Math.abs(nowS - ts) > 600) fail(`${name}: header timestamp ${ts} is ${nowS - ts}s old`);
  if (trips.length === 0) fail(`${name}: no trip updates`);
  if (unknownRoutes.length) fail(`${name}: routes missing from FEEDS: ${unknownRoutes.join(",")}`);
  // A few yard/non-revenue ids are normal; many means the static data is out of date.
  if (stopIds.length && unknownStops.length / stopIds.length > 0.1) {
    fail(`${name}: ${unknownStops.length} of ${stopIds.length} stop ids unknown, e.g. ${[...new Set(unknownStops)].slice(0, 5).join(",")}`);
  }
}

for (const stopId of ["127", "631", "R20", "A41", "L08"]) {
  const stop = index.resolve(index.data.stops[stopId]?.station ?? stopId);
  if (!stop) {
    fail(`static data has no stop ${stopId}`);
    continue;
  }
  const r = computeArrivals(stop, Object.values(feeds), index, { now: nowS, limit: 3 });
  const n = r.groups.reduce((a, g) => a + g.arrivals.length, 0);
  console.log(`${stop.name}: ${r.groups.length} route/direction groups, ${n} arrivals`);
  if (n === 0) fail(`${stop.name} (${stop.id}): no arrivals`);
}

try {
  const path = await fetchPathFeed({ timeoutMs: 20_000 });
  const trains = Object.values(path.stations).flat();
  const newest = Math.max(0, ...trains.map((t) => t.updatedAt));
  const unknownStations = Object.keys(path.stations).filter((id) => !pathStation(id));
  const missingStations = PATH_STATIONS.filter((s) => !path.stations[s.id]).map((s) => s.id);
  const unknownColors = [...new Set(trains.map((t) => t.colors))].filter((c) => !routeForColors(c));
  console.log(`path: ${Object.keys(path.stations).length} stations, ${trains.length} trains, age ${nowS - newest}s, ${path.skipped} skipped entries`);
  if (path.skipped) fail(`path: ${path.skipped} entries the parser could not read`);
  if (Math.abs(nowS - newest) > 600) fail(`path: newest update ${newest} is ${nowS - newest}s old`);
  if (unknownStations.length) fail(`path: stations missing from PATH_STATIONS: ${unknownStations.join(",")}`);
  if (missingStations.length) fail(`path: stations missing from the feed: ${missingStations.join(",")}`);
  if (unknownColors.length) fail(`path: line colors with no route: ${unknownColors.join(" ")}`);
  const jsq = computePathArrivals(pathStation("JSQ")!, path, { now: nowS, limit: 3 });
  const n = jsq.groups.reduce((a, g) => a + g.arrivals.length, 0);
  console.log(`${jsq.station.name}: ${jsq.groups.length} route/direction groups, ${n} arrivals`);
  if (n === 0) fail("Journal Square (JSQ): no arrivals");
} catch (err) {
  fail(`path: ${(err as Error).message}`);
}

const base = process.env.TRANSIT_BASE_URL?.replace(/\/$/, "");
if (base) {
  const token = process.env.TRANSIT_TOKEN?.split(",")[0]?.trim() ?? "";
  const call = async (path: string, withToken: boolean) => {
    const res = await fetch(base + path, { headers: withToken ? { "x-transit-token": token } : {} });
    console.log(`GET ${path} ${withToken ? "with" : "without"} token: ${res.status}, x-vercel-cache ${res.headers.get("x-vercel-cache")}`);
    return res;
  };
  const expectStatus = (res: Response, status: number, what: string) => {
    if (res.status !== status) fail(`${what}: expected ${status}, got ${res.status}`);
  };
  expectStatus(await call("/health", false), 200, "/health");
  const arrivals = `/subway/arrivals?stop=${encodeURIComponent(index.data.stops["127"]!.station)}&smoke=${nowS}`;
  expectStatus(await call(arrivals, false), 401, "arrivals without token");
  expectStatus(await call(arrivals, true), 200, "arrivals with token");
  const again = await call(arrivals, true);
  expectStatus(again, 200, "arrivals again");
  if (!["HIT", "STALE"].includes(again.headers.get("x-vercel-cache") ?? "")) fail("repeated arrivals call was not a CDN hit");
  expectStatus(await call(arrivals, false), 401, "arrivals without token after a cached hit");
  expectStatus(await call("/stops/search?q=times%20sq", false), 401, "search without token");
  expectStatus(await call("/stops/search?q=times%20sq", true), 200, "search with token");
  const preview = `/preview/subway?q=times%20sq&smoke=${nowS}`;
  expectStatus(await call(preview, false), 401, "preview without token");
  const line = await call(preview, true);
  expectStatus(line, 200, "preview with token");
  const text = await line.text();
  console.log(`preview: ${text.trimEnd()}`);
  if (!/^Times Sq-42 St · .+\n$/.test(text)) fail(`preview: unexpected line ${JSON.stringify(text)}`);

  const pathArrivals = `/path/arrivals?station=JSQ&smoke=${nowS}`;
  expectStatus(await call(pathArrivals, false), 401, "PATH arrivals without token");
  expectStatus(await call(pathArrivals, true), 200, "PATH arrivals with token");
  expectStatus(await call("/path/stations", true), 200, "PATH stations with token");
  const pathLine = await call(`/preview/path?q=journal%20square&smoke=${nowS}`, true);
  expectStatus(pathLine, 200, "PATH preview with token");
  const pathText = await pathLine.text();
  console.log(`preview: ${pathText.trimEnd()}`);
  if (!/^Journal Square · .+\n$/.test(pathText)) fail(`PATH preview: unexpected line ${JSON.stringify(pathText)}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nsmoke test passed");
