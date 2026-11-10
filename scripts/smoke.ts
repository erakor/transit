/**
 * Smoke test against the live MTA and Citi Bike feeds (and, optionally, a deployment).
 *
 *   pnpm smoke
 *   TRANSIT_BASE_URL=https://<deployment> TRANSIT_TOKEN=... pnpm smoke
 *
 * Fails when an upstream change would break the service: a feed that no longer decodes, stale
 * data, routes the FEEDS table doesn't know, stop ids missing from the static data, or a big
 * station with no arrivals; for Citi Bike, a feed that changed shape, stale status, or no bikes
 * station near Times Sq.
 */
import { fetchGbfs } from "../src/citibike/feeds.js";
import { joinStations, nearestStations } from "../src/citibike/stations.js";
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
const TIMES_SQ = { lat: 40.7559, lon: -73.9871 };

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
  const [information, status] = await Promise.all([
    fetchGbfs("station_information", { timeoutMs: 20_000 }),
    fetchGbfs("station_status", { timeoutMs: 20_000 }),
  ]);
  const joined = joinStations(information, status);
  const listed = information.data.stations.length;
  const stations = [...joined.byId.values()];
  let bikes = 0, ebikes = 0, docks = 0;
  for (const s of stations) {
    bikes += s.bikes;
    ebikes += s.ebikes;
    docks += s.docks;
  }
  console.log(
    `citibike: ${stations.length} of ${listed} stations installed, ${bikes} bikes, ${ebikes} e-bikes, ${docks} free docks, ` +
      `age ${nowS - joined.updatedAt}s`,
  );
  if (Math.abs(nowS - joined.updatedAt) > 600) fail(`citibike: station_status is ${nowS - joined.updatedAt}s old`);
  // Seasonal closures take some stations off the street; losing most of them means a broken join.
  if (stations.length < 1000 || stations.length < listed * 0.8) fail(`citibike: only ${stations.length} of ${listed} stations joined`);
  if (bikes + ebikes === 0 || docks === 0) fail("citibike: no bikes or no free docks anywhere");
  if (!stations.some((s) => s.ebikes > 0)) fail("citibike: no e-bikes anywhere (num_ebikes_available gone?)");
  const near = nearestStations(stations, TIMES_SQ.lat, TIMES_SQ.lon, 3);
  console.log(`citibike near Times Sq: ${near.map((s) => `${s.name} (${s.distance} m)`).join(", ")}`);
  if (!near[0] || near[0].distance > 500) fail("citibike: no station within 500 m of Times Sq");
} catch (err) {
  fail(`citibike: ${(err as Error).message}`);
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
  const nearby = `/citibike/nearby?lat=${TIMES_SQ.lat}&lon=${TIMES_SQ.lon}&n=3&smoke=${nowS}`;
  expectStatus(await call(nearby, false), 401, "citibike nearby without token");
  const near = await call(nearby, true);
  expectStatus(near, 200, "citibike nearby with token");
  const first = near.ok ? ((await near.json()) as { stations?: { id: string; name: string }[] }).stations?.[0] : undefined;
  if (!first) fail("citibike nearby: no stations");
  else {
    console.log(`citibike nearby: ${first.name}`);
    expectStatus(await call(`/citibike/station?id=${encodeURIComponent(first.id)}&smoke=${nowS}`, true), 200, "citibike station with token");
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nsmoke test passed");
