/**
 * Smoke test against the live feeds (and, optionally, a deployment).
 *
 *   pnpm smoke
 *   TRANSIT_BASE_URL=https://<deployment> TRANSIT_TOKEN=... pnpm smoke
 *
 * Fails when an upstream change would break the service: a feed that no longer decodes, stale
 * data, routes the FEEDS table doesn't know, stop ids missing from the static data, or a big
 * station with no arrivals. For PATH: entries the parser can't read, stations or line colors it
 * doesn't know, stale data, or Journal Square with no trains. For LIRR, Metro-North and NYC
 * Ferry: stale or empty feeds, stop or route ids missing from the static data, ferry trips missing
 * from the static schedule, a main stop with no departures, or no vehicle positions. For alerts:
 * a feed that no longer decodes or has gone a day without an update.
 */
import { AGENCIES } from "../src/agency/agencies.js";
import { computeAgencyArrivals } from "../src/agency/arrivals.js";
import { computeAgencyVehicles } from "../src/agency/vehicles.js";
import { computeAlerts } from "../src/alerts.js";
import { BUS_ALERTS_FEED, FALLBACK_ROUTE, SUBWAY_ALERTS_FEED } from "../src/routes/alerts.js";
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

/** A stop that always has service at the hours the smoke test runs. */
const MAIN_STOP: Record<string, string> = { lirr: "Jamaica", mnr: "Grand Central", ferry: "Wall St/Pier 11" };
for (const agency of Object.values(AGENCIES)) {
  try {
    const feed = await fetchFeed(agency.tripsFeed, { timeoutMs: 20_000 });
    const positions = agency.vehiclesFeed ? await fetchFeed(agency.vehiclesFeed, { timeoutMs: 20_000 }) : feed;
    const ts = Number(feed.header.timestamp ?? 0);
    const trips = feed.entity.flatMap((e) => (e.tripUpdate ? [e.tripUpdate] : []));
    const stopIds = trips.flatMap((t) => (t.stopTimeUpdate ?? []).map((s) => s.stopId ?? ""));
    const unknownStops = stopIds.filter((s) => !agency.data.stops[s]);
    const routeIds = new Set(trips.map((t) => t.trip?.routeId || agency.data.trips?.[t.trip?.tripId ?? ""]?.route || ""));
    const unknownRoutes = [...routeIds].filter((r) => r && !agency.data.routes[r]);
    const unscheduled = agency.data.trips ? trips.filter((t) => !agency.data.trips![t.trip?.tripId ?? ""]) : [];
    const { vehicles } = computeAgencyVehicles(positions === feed ? [feed] : [positions, feed], agency.data, { now: nowS });
    console.log(
      `${agency.id}: ${trips.length} trips, age ${nowS - ts}s, ${unknownStops.length}/${stopIds.length} stop updates with unknown stop ids, ` +
        `${unscheduled.length} trips not in the static schedule, ${vehicles.length} vehicles`,
    );
    if (Math.abs(nowS - ts) > 600) fail(`${agency.id}: header timestamp ${ts} is ${nowS - ts}s old`);
    if (trips.length === 0) fail(`${agency.id}: no trip updates`);
    if (unknownRoutes.length) fail(`${agency.id}: routes missing from the static data: ${unknownRoutes.join(",")}`);
    if (stopIds.length && unknownStops.length / stopIds.length > 0.1) {
      fail(`${agency.id}: ${unknownStops.length} of ${stopIds.length} stop ids unknown, e.g. ${[...new Set(unknownStops)].slice(0, 5).join(",")}`);
    }
    // The static schedule is a day behind at worst; many unknown trips means the refresh is failing.
    if (trips.length && unscheduled.length / trips.length > 0.2) fail(`${agency.id}: ${unscheduled.length} of ${trips.length} trips are not in the static schedule`);
    if (vehicles.length === 0) fail(`${agency.id}: no vehicle positions`);
    const main = Object.values(agency.data.stops).find((s) => s.name === MAIN_STOP[agency.id]);
    const n = main ? computeAgencyArrivals(main, feed, agency.data, { now: nowS, limit: 30 }).arrivals.length : 0;
    console.log(`${MAIN_STOP[agency.id]}: ${n} departures`);
    if (n === 0) fail(`${agency.id}: no departures at ${MAIN_STOP[agency.id]}`);
  } catch (err) {
    fail(`${agency.id}: ${(err as Error).message}`);
  }
}

for (const name of [SUBWAY_ALERTS_FEED, BUS_ALERTS_FEED, ...Object.values(AGENCIES).map((a) => a.alertsFeed)]) {
  const label = name.split("/").slice(-2).join("/");
  try {
    const feed = await fetchFeed(name, { timeoutMs: 20_000 });
    const { alerts, updatedAt } = computeAlerts(feed, { now: nowS, route: FALLBACK_ROUTE, stopName: () => undefined });
    console.log(`${label}: ${feed.entity.length} alerts, ${alerts.length} in effect, age ${nowS - (updatedAt ?? 0)}s`);
    if (Math.abs(nowS - (updatedAt ?? 0)) > 86_400) fail(`${label}: header timestamp ${updatedAt} is ${nowS - (updatedAt ?? 0)}s old`);
    if (feed.entity.some((e) => !e.alert)) fail(`${label}: entities that are not alerts`);
  } catch (err) {
    fail(`${label}: ${(err as Error).message}`);
  }
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

  // These all go through one function behind a rewrite with a query string (see vercel.json).
  const jamaica = Object.values(AGENCIES.lirr!.data.stops).find((s) => s.name === "Jamaica")!;
  const lirr = `/lirr/arrivals?station=${jamaica.id}&smoke=${nowS}`;
  expectStatus(await call(lirr, false), 401, "LIRR arrivals without token");
  const lirrRes = await call(lirr, true);
  expectStatus(lirrRes, 200, "LIRR arrivals with token");
  if (lirrRes.status === 200 && (await lirrRes.json()).station?.name !== "Jamaica") fail("LIRR arrivals: not Jamaica's");
  for (const path of ["/mnr/stations?q=grand%20central", "/ferry/stops", "/ferry/vehicles", "/mnr/alerts", "/bus/alerts", "/subway/alerts?route=A", "/subway/vehicles?route=L"]) {
    expectStatus(await call(path, true), 200, path);
  }
  expectStatus(await call("/lirr/nope", true), 404, "an unknown agency route");
  const mnrLine = await call(`/preview/mnr?q=grand%20central&smoke=${nowS}`, true);
  expectStatus(mnrLine, 200, "Metro-North preview with token");
  const mnrText = await mnrLine.text();
  console.log(`preview: ${mnrText.trimEnd()}`);
  if (!/^Grand Central · .+\n$/.test(mnrText)) fail(`Metro-North preview: unexpected line ${JSON.stringify(mnrText)}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nsmoke test passed");
