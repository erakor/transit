/**
 * Smoke test against the live MTA feeds (and, optionally, a deployment).
 *
 *   pnpm smoke
 *   TRANSIT_BASE_URL=https://<deployment> TRANSIT_TOKEN=... pnpm smoke
 *
 * Fails when an upstream change would break the service: a feed that no longer decodes, stale
 * data, routes the FEEDS table doesn't know, stop ids missing from the static data, or a big
 * station with no arrivals.
 */
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
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nsmoke test passed");
