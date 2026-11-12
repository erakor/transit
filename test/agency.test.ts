import { describe, expect, it } from "vitest";
import { AGENCIES, findStop, searchStops } from "#src/agency/agencies.js";
import { computeAgencyArrivals } from "#src/agency/arrivals.js";
import type { AgencyData } from "#src/agency/types.js";
import { computeAgencyVehicles } from "#src/agency/vehicles.js";
import { ALERTS_CACHE, LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE } from "#src/http.js";
import { agencyHandler, agencyRoute } from "#src/routes/agency.js";
import { buildAgencyData } from "#src/static/agency.js";
import { clearFeedMemo, decodeFeed, VEHICLE_MAX_AGE_S } from "#src/gtfsrt.js";
import { feedFrom } from "./feed.js";
import { auth, fixture, fixtureFetcher, FIXTURE_NOW_MS, get, useRouteTestSetup } from "./helpers.js";

const NOW = 1_800_000_000;
const FIXTURE_NOW = Math.floor(FIXTURE_NOW_MS / 1000);

const files = {
  "feed_info.txt": "feed_publisher_name,feed_version\nBoats,v7\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_color,route_text_color\nER,ER,East River,00839c,\nAS,AS,Astoria,FF6B00,121212\nX,,,,\n",
  "stops.txt":
    "stop_id,stop_name,stop_lat,stop_lon,location_type\n" +
    "a,Wall St,40.7031611,-74.006144,\nb,Dumbo,40.703,-73.99,0\nc,Astoria,40.77,-73.93,\nd,Unserved,40.7,-73.9,\nhub,Terminal Building,40.7,-74.0,1\n",
  "trips.txt": 'route_id,service_id,trip_id,trip_headsign\nER,1,t1,"Astoria (via Dumbo)"\nAS,1,t2,\nER,1,t3,Nowhere\n',
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
    "t1,23:50:00,23:50:00,a,1\nt1,24:10:30,24:12:00,c,3\nt1,23:58:00,23:59:00,b,2\nt2,08:00:00,08:00:00,c,1\nt2,08:30:00,08:30:00,a,2\nt9,08:00:00,08:00:00,a,1\n",
};

describe("buildAgencyData", () => {
  it("keeps boarding stops with the routes serving them, routes by name", () => {
    const data = buildAgencyData(files);
    expect(Object.keys(data.routes)).toEqual(["AS", "ER", "X"]);
    expect(data.routes.ER).toEqual({ id: "ER", name: "East River", color: "#00839C", textColor: "#FFFFFF" });
    expect(data.routes.X).toMatchObject({ name: "X", color: "#808183" });
    expect(Object.keys(data.stops)).toEqual(["a", "b", "c", "d"]);
    expect(data.stops.a).toEqual({ id: "a", name: "Wall St", lat: 40.703161, lon: -74.006144, routes: ["AS", "ER"] });
    expect(data.stops.d!.routes).toEqual([]);
    expect(data.feedVersion).toBe("v7");
    expect(data.trips).toBeUndefined();
  });

  it("keeps trips on request: stops in sequence with offsets past midnight, headsign from the last stop", () => {
    const data = buildAgencyData(files, { trips: true });
    expect(data.trips).toEqual({
      t1: { route: "ER", headsign: "Astoria", stops: [["a", 0], ["b", 480], ["c", 1230]] },
      t2: { route: "AS", headsign: "Wall St", stops: [["c", 0], ["a", 1800]] },
    });
    expect(JSON.stringify(buildAgencyData(files, { trips: true }))).toBe(JSON.stringify(data));
  });

  it("has no version without feed_info and fails on a missing file", () => {
    expect(buildAgencyData({ ...files, "feed_info.txt": undefined } as never).feedVersion).toBe("");
    expect(() => buildAgencyData({ ...files, "trips.txt": undefined } as never)).toThrow(/trips.txt/);
  });
});

describe("committed agency data", () => {
  it("looks like the real systems", () => {
    expect(searchStops(AGENCIES.lirr!.data, "jamaica")[0]?.name).toBe("Jamaica");
    expect(searchStops(AGENCIES.lirr!.data, "penn station")[0]?.name).toBe("Penn Station");
    expect(searchStops(AGENCIES.mnr!.data, "grand central")[0]).toMatchObject({ id: "1", name: "Grand Central" });
    expect(searchStops(AGENCIES.ferry!.data, "wall st")[0]?.name).toMatch(/^Wall St/);
    expect(Object.keys(AGENCIES.ferry!.data.trips ?? {}).length).toBeGreaterThan(100);
    expect(AGENCIES.lirr!.data.trips).toBeUndefined();
    for (const a of Object.values(AGENCIES)) {
      expect(Object.keys(a.data.stops).length, a.id).toBeGreaterThan(20);
      for (const s of Object.values(a.data.stops)) for (const r of s.routes) expect(a.data.routes[r], `${a.id} ${r}`).toBeDefined();
    }
  });

  it("finds stops by id whatever the case", () => {
    expect(findStop(AGENCIES.mnr!.data, " 1 ")?.name).toBe("Grand Central");
    expect(findStop(AGENCIES.mnr!.data, "nope")).toBeUndefined();
  });
});

const data: AgencyData = buildAgencyData(files, { trips: true });
const plain: AgencyData = { ...data, trips: undefined };
const A = data.stops.a!;
const at = (stopId: string, t: number, extra: object = {}) => ({ stopId, arrival: { time: t }, departure: { time: t }, ...extra });

describe("computeAgencyArrivals", () => {
  const feed = feedFrom(NOW - 3, [
    { tripUpdate: { trip: { tripId: "late", routeId: "ER" }, stopTimeUpdate: [{ stopId: "a", arrival: { time: NOW + 500, delay: 30 }, departure: { time: NOW + 600, delay: 90 } }, at("c", NOW + 2000)] } },
    { tripUpdate: { trip: { tripId: "ending", routeId: "AS" }, stopTimeUpdate: [at("c", NOW - 900), { stopId: "a", arrival: { time: NOW + 120 } }] } },
    { tripUpdate: { trip: { tripId: "gone", routeId: "ER" }, stopTimeUpdate: [at("a", NOW - 1), at("c", NOW + 900)] } },
    { tripUpdate: { trip: { tripId: "skips", routeId: "ER" }, stopTimeUpdate: [at("a", NOW + 60, { scheduleRelationship: 1 }), at("c", NOW + 900)] } },
    { tripUpdate: { trip: { tripId: "canceled", routeId: "ER", scheduleRelationship: 3 }, stopTimeUpdate: [at("a", NOW + 60)] } },
    { tripUpdate: { trip: { tripId: "elsewhere", routeId: "ER" }, stopTimeUpdate: [at("b", NOW + 60), at("c", NOW + 900)] } },
    { tripUpdate: { trip: { tripId: "odd", routeId: "NEW" }, stopTimeUpdate: [at("a", NOW + 300), at("zzz", NOW + 900)] } },
    { tripUpdate: { trip: { tripId: "noroute" }, stopTimeUpdate: [at("a", NOW + 30)] } },
  ]);

  it("lists departures soonest first with names joined in, dropping past, skipped and canceled ones", () => {
    const r = computeAgencyArrivals(A, feed, plain, { now: NOW, limit: 10 });
    expect(r.stop).toEqual({ id: "a", name: "Wall St" });
    expect(r.updatedAt).toBe(NOW - 3);
    expect(r.arrivals).toEqual([
      { time: NOW + 120, route: "AS", name: "Astoria", color: "#FF6B00", textColor: "#121212", headsign: "Wall St", tripId: "ending" },
      { time: NOW + 300, route: "NEW", name: "NEW", color: "#808183", textColor: "#FFFFFF", headsign: "Wall St", tripId: "odd" },
      { time: NOW + 600, delay: 90, route: "ER", name: "East River", color: "#00839C", textColor: "#FFFFFF", headsign: "Astoria", tripId: "late" },
    ]);
  });

  it("keeps limit departures", () => {
    expect(computeAgencyArrivals(A, feed, plain, { now: NOW, limit: 2 }).arrivals.map((a) => a.tripId)).toEqual(["ending", "odd"]);
  });

  it("extends a feed that predicts only the next stop with the schedule", () => {
    const next = feedFrom(NOW, [
      // t1 a(0) b(480) c(1230): left a, due at b 100 s from now.
      { tripUpdate: { trip: { tripId: "t1" }, stopTimeUpdate: [{ stopId: "a", departure: { time: NOW - 400 } }, { stopId: "b", arrival: { time: NOW + 100 } }] } },
      // t2 c(0) a(1800): waiting at its first stop.
      { tripUpdate: { trip: { tripId: "t2" }, stopTimeUpdate: [{ stopId: "c", arrival: { time: NOW + 50 }, departure: { time: NOW + 200 } }] } },
      { tripUpdate: { trip: { tripId: "unscheduled" }, stopTimeUpdate: [at("a", NOW + 10)] } },
    ]);
    const times = (stop: string) => computeAgencyArrivals(data.stops[stop]!, next, data, { now: NOW, limit: 10 }).arrivals.map((a) => [a.tripId, a.time - NOW, a.route, a.headsign]);
    expect(times("c")).toEqual([["t2", 200, "AS", "Wall St"], ["t1", 100 + 750, "ER", "Astoria"]]);
    expect(times("b")).toEqual([["t1", 100, "ER", "Astoria"]]);
    // t1 already left a; t2 gets there 1800 s after its (predicted) arrival at c.
    expect(times("a")).toEqual([["t2", 50 + 1800, "AS", "Wall St"]]);
  });

  describe.each(Object.values(AGENCIES))("on the recorded $name feed", (agency) => {
    const feed = decodeFeed(fixture(agency.id === "ferry" ? "ferry-tripupdate.pb" : `gtfs-${agency.id}.pb`));
    it("finds upcoming departures with known routes and stops", () => {
      let total = 0;
      const stopsWithService = new Set<string>();
      for (const stop of Object.values(agency.data.stops)) {
        const { arrivals } = computeAgencyArrivals(stop, feed, agency.data, { now: FIXTURE_NOW, limit: 30 });
        for (const a of arrivals) {
          expect(agency.data.routes[a.route], `route ${a.route}`).toBeDefined();
          expect(a.headsign, `trip ${a.tripId}`).not.toBe("");
          expect(a.time).toBeGreaterThanOrEqual(FIXTURE_NOW);
          expect(a.time).toBeLessThan(FIXTURE_NOW + 12 * 3600);
          stopsWithService.add(stop.id);
        }
        expect(arrivals.map((a) => a.time)).toEqual(arrivals.map((a) => a.time).sort((x, y) => x - y));
        total += arrivals.length;
      }
      expect(total).toBeGreaterThan(20);
      expect(stopsWithService.size).toBeGreaterThan(10);
    });

    it("places vehicles around New York", () => {
      const feeds = agency.vehiclesFeed ? [decodeFeed(fixture("ferry-vehicleposition.pb")), feed] : [feed];
      const { vehicles, updatedAt } = computeAgencyVehicles(feeds, agency.data, { now: FIXTURE_NOW });
      expect(updatedAt).toBeGreaterThan(FIXTURE_NOW - 600);
      expect(vehicles.length).toBeGreaterThan(5);
      for (const v of vehicles) {
        expect(v.lat).toBeGreaterThan(40);
        expect(v.lat).toBeLessThan(42.5);
        expect(v.lon).toBeGreaterThan(-75);
        expect(v.lon).toBeLessThan(-71.5);
        expect(v.id).not.toBe("");
      }
      const routed = vehicles.filter((v) => v.route && agency.data.routes[v.route.id]);
      expect(routed.length / vehicles.length).toBeGreaterThan(0.7);
    });
  });
});

describe("computeAgencyVehicles", () => {
  const position = { latitude: 40.7031234, longitude: -74.0061234 };
  const feed = feedFrom(NOW, [
    { id: "T", tripUpdate: { trip: { tripId: "trip-1", routeId: "ER" }, stopTimeUpdate: [at("b", NOW + 60), at("c", NOW + 900)] } },
    { id: "V", vehicle: { trip: { tripId: "trip-1" }, position, currentStatus: 1, stopId: "b", timestamp: NOW - 20, vehicle: { id: "9", label: "H200" } } },
    // Metro-North style: one entity, the vehicle names the entity id as its trip.
    { id: "501", tripUpdate: { trip: { tripId: "x77", routeId: "AS" }, stopTimeUpdate: [at("a", NOW + 60)] }, vehicle: { trip: { tripId: "501" }, position, timestamp: NOW } },
    { id: "S", vehicle: { trip: { tripId: "t2" }, position, timestamp: NOW - 5 } },
    { id: "old", vehicle: { trip: { tripId: "trip-1" }, position, timestamp: NOW - VEHICLE_MAX_AGE_S - 1 } },
    { id: "nowhere", vehicle: { trip: { tripId: "trip-1" }, timestamp: NOW } },
  ]);

  it("joins each vehicle to its trip's route and headsign, live or scheduled", () => {
    const { vehicles, updatedAt } = computeAgencyVehicles([feed], data, { now: NOW });
    expect(updatedAt).toBe(NOW);
    expect(vehicles.map((v) => [v.id, v.route?.id, v.headsign, v.status, v.stop?.name ?? null])).toEqual([
      ["501", "AS", "Wall St", null, null],
      ["S", "AS", "Wall St", null, null],
      ["9", "ER", "Astoria", "STOPPED_AT", "Dumbo"],
    ]);
    expect(vehicles[2]).toMatchObject({ label: "H200", tripId: "trip-1", time: NOW - 20 });
    // Coordinates are 32-bit floats in the feed, rounded to 5 decimals (about a meter).
    expect(vehicles[2]!.lat).toBeCloseTo(40.70312, 4);
    expect(vehicles[2]!.lon).toBeCloseTo(-74.00612, 4);
    expect(String(vehicles[2]!.lat).length).toBeLessThanOrEqual(8);
  });

  it("filters by route", () => {
    expect(computeAgencyVehicles([feed], data, { now: NOW, route: "ER" }).vehicles.map((v) => v.id)).toEqual(["9"]);
  });
});

describe("agency routes", () => {
  useRouteTestSetup();

  function call(path: string, fail: string[] = []) {
    const fetcher = fixtureFetcher(fail);
    return { fetcher, res: agencyHandler({ fetcher, now: () => FIXTURE_NOW_MS })(get(path, auth)) };
  }

  it("reads the agency and operation from the public path or the rewritten query", () => {
    const route = (path: string) => agencyRoute(new URL(`https://transit.test${path}`));
    expect(route("/lirr/arrivals?station=102")).toEqual({ agency: "lirr", op: "arrivals" });
    expect(route("/preview/ferry?q=wall")).toEqual({ agency: "ferry", op: "preview" });
    expect(route("/api/agency?agency=mnr&op=stations&q=rye")).toEqual({ agency: "mnr", op: "stations" });
    expect(route("/api/agency")).toBeUndefined();
  });

  it("answers the same through the rewritten URL", async () => {
    const direct = await (await call("/mnr/arrivals?station=1&limit=2").res).json();
    const rewritten = await (await call("/api/agency?agency=mnr&op=arrivals&station=1&limit=2").res).json();
    expect(rewritten).toEqual(direct);
    expect(direct.arrivals).toHaveLength(2);
  });

  it.each([
    ["/lirr/arrivals?station=102", "station", "gtfs-lirr", "Jamaica"],
    ["/mnr/arrivals?station=1", "station", "gtfs-mnr", "Grand Central"],
    ["/ferry/arrivals?stop=87", "stop", "ferry-tripupdate", "Wall St/Pier 11"],
  ])("%s lists departures under `%s` with live cache headers", async (path, key, feed, name) => {
    const { fetcher, res } = call(path);
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(fetcher.calls).toEqual([feed]);
    const body = await r.json();
    expect(body[key].name).toBe(name);
    expect(body.updatedAt).toBeTypeOf("number");
    expect(body.arrivals.length).toBeGreaterThan(0);
    expect(body.arrivals.length).toBeLessThanOrEqual(10);
    for (const a of body.arrivals) {
      expect(Object.keys(a).filter((k) => k !== "delay").sort()).toEqual(["color", "headsign", "name", "route", "textColor", "time", "tripId"]);
    }
  });

  it.each([
    ["/lirr/arrivals", 400, "station is required"],
    ["/ferry/arrivals", 400, "stop is required"],
    ["/lirr/arrivals?station=99999", 404, "unknown station 99999"],
    ["/lirr/arrivals?station=102&limit=0", 400, "limit must be a positive integer"],
    ["/lirr/alerts?station=99999", 404, "unknown station 99999"],
    ["/mnr/vehicles?route=nope", 404, "unknown route nope"],
    ["/preview/mnr", 400, "q or station is required"],
    ["/preview/ferry?q=zzzz", 404, "no matching stop"],
    ["/lirr/stops", 404, "not found"],
    ["/ferry/stations", 404, "not found"],
    ["/lirr/toString", 404, "not found"],
    ["/njt/arrivals", 404, "not found"],
    ["/bus/arrivals", 404, "not found"],
    ["/api/agency", 404, "not found"],
  ])("rejects %s with %i", async (path, status, error) => {
    const r = await call(path).res;
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ error });
  });

  it.each([
    ["/lirr/arrivals?station=102", "gtfs-lirr", "LIRR feed unavailable"],
    ["/preview/mnr?q=rye", "gtfs-mnr", "Metro-North feed unavailable"],
    ["/ferry/vehicles", "ferry-vehicleposition", "NYC Ferry feed unavailable"],
    ["/mnr/alerts", "mnr-alerts", "Metro-North alerts unavailable"],
    ["/bus/alerts", "bus-alerts", "MTA alerts unavailable"],
  ])("%s is 502 when its feed fails", async (path, feed, error) => {
    const r = await call(path, [feed]).res;
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error });
  });

  it("lists every station by name, or the ones matching q", async () => {
    const all = await call("/lirr/stations").res;
    expect(all.headers.get("cache-control")).toBe(STATIC_CACHE);
    const { stations } = await all.json();
    expect(stations).toHaveLength(Object.keys(AGENCIES.lirr!.data.stops).length);
    expect(stations.map((s: { name: string }) => s.name)).toEqual(stations.map((s: { name: string }) => s.name).sort((a: string, b: string) => a.localeCompare(b)));

    const found = await (await call("/mnr/stations?q=white%20plains&limit=1").res).json();
    expect(found.query).toBe("white plains");
    expect(found.stations).toHaveLength(1);
    expect(found.stations[0]).toMatchObject({ name: "White Plains", routes: [{ name: "Harlem", color: "#0039A6", textColor: "#FFFFFF" }] });
    expect(found.stations[0].lat).toBeTypeOf("number");

    const { stops } = await (await call("/ferry/stops?q=wall").res).json();
    expect(stops[0].name).toBe("Wall St/Pier 11");
  });

  it("previews the next departure per destination, without trips that end at the stop", async () => {
    for (const [path, name] of [["/preview/lirr?q=penn%20station", "Penn Station"], ["/preview/mnr?station=1", "Grand Central"], ["/preview/ferry?q=wall", "Wall St/Pier 11"]] as const) {
      const r = await call(path).res;
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe(PREVIEW_CACHE);
      const line = await r.text();
      expect(line).toMatch(new RegExp(`^${name}( · [^·]+ \\d+){1,6} min( · …)?\\n$`));
      expect(line.slice(name.length)).not.toContain(`${name} `);
      expect(Buffer.byteLength(line)).toBeLessThan(1024);
    }
  });

  it("says which vehicles aren't coming when none are", async () => {
    // Two days after the recording, every trip in it is over.
    const later = (path: string) => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS + 2 * 86_400_000 })(get(path, auth));
    expect(await (await later("/preview/ferry?stop=87")).text()).toBe("Wall St/Pier 11 · no ferries soon\n");
    clearFeedMemo();
    expect(await (await later("/preview/lirr?station=102")).text()).toBe("Jamaica · no trains soon\n");
  });

  it("returns vehicles, for the ferry from its two feeds", async () => {
    const { fetcher, res } = call("/ferry/vehicles");
    const r = await res;
    expect(r.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(fetcher.calls.sort()).toEqual(["ferry-tripupdate", "ferry-vehicleposition"]);
    const body = await r.json();
    expect(body.vehicles.length).toBeGreaterThan(5);
    expect(Object.keys(body.vehicles[0]).sort()).toEqual(["headsign", "id", "label", "lat", "lon", "route", "status", "stop", "time", "tripId"]);

    const harlem = await (await call("/mnr/vehicles?route=2").res).json();
    expect(harlem.vehicles.length).toBeGreaterThan(0);
    for (const v of harlem.vehicles) expect(v.route.name).toBe("Harlem");
  });

  it("still returns ferry positions when the trip updates fail", async () => {
    const r = await call("/ferry/vehicles", ["ferry-tripupdate"]).res;
    expect(r.status).toBe(200);
    expect((await r.json()).vehicles.length).toBeGreaterThan(5);
  });

  it("returns the alerts in effect, filtered by route or station", async () => {
    const r = await call("/lirr/alerts").res;
    expect(r.headers.get("cache-control")).toBe(ALERTS_CACHE);
    const all = await r.json();
    expect(all.alerts.length).toBeGreaterThan(0);
    expect(Object.keys(all.alerts[0]).sort()).toEqual(["description", "end", "header", "id", "planned", "routes", "start", "stops"]);

    const routeId: string = all.alerts.find((a: { routes: unknown[] }) => a.routes.length > 0).routes[0].id;
    const byRoute = await (await call(`/lirr/alerts?route=${routeId}`).res).json();
    expect(byRoute.alerts.length).toBeGreaterThan(0);
    expect(byRoute.alerts.length).toBeLessThanOrEqual(all.alerts.length);
    for (const a of byRoute.alerts) expect(a.routes.map((x: { id: string }) => x.id)).toContain(routeId);

    const byStation = await (await call("/lirr/alerts?station=102").res).json();
    expect(byStation.station).toEqual({ id: "102", name: "Jamaica" });
    expect((await (await call("/ferry/alerts").res).json()).alerts).toEqual([]);
  });

  it("returns bus alerts by route, whatever the case", async () => {
    const all = await (await call("/bus/alerts").res).json();
    const routeId: string = all.alerts[0].routes[0].id;
    const one = await (await call(`/bus/alerts?route=${routeId.toLowerCase()}`).res).json();
    expect(one.alerts.length).toBeGreaterThan(0);
    expect(one.alerts.length).toBeLessThan(all.alerts.length);
    expect(one.alerts[0].routes).toContainEqual({ id: routeId, name: routeId, color: "#808183", textColor: "#FFFFFF" });
  });
});
