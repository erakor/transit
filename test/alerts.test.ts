import { describe, expect, it } from "vitest";
import { computeAlerts, type AlertsOptions } from "../src/alerts.js";
import { SUBWAY_DATA } from "../src/data/subway.generated.js";
import { ALERTS_CACHE, LIVE_CACHE } from "../src/http.js";
import { subwayAlertsHandler } from "../src/routes/alerts.js";
import { subwayVehiclesHandler } from "../src/routes/vehicles.js";
import { StationIndex } from "../src/stops/stations.js";
import { decodeFeed, VEHICLE_MAX_AGE_S } from "../src/gtfsrt.js";
import { computeSubwayTrains } from "../src/subway/vehicles.js";
import { encodeFeed, feedFrom } from "./feed.js";
import { auth, fixture, fixtureFetcher, FIXTURE_NOW_MS, get, useRouteTestSetup } from "./helpers.js";

const NOW = 1_800_000_000;
const TIMES_SQ = SUBWAY_DATA.stops["127"]!.station;

const en = (text: string, html = `<p>${text}</p>`) => ({ translation: [{ text: html, language: "en-html" }, { text, language: "en" }] });
const feed = feedFrom(NOW - 30, [
  { id: "lmm:alert:1", alert: { activePeriod: [{ start: NOW - 600 }], informedEntity: [{ agencyId: "MTASBWY", routeId: "A" }, { agencyId: "MTASBWY", routeId: "C" }], headerText: en(" [A][C] trains are delayed. ") } },
  { id: "lmm:planned_work:2", alert: {
    activePeriod: [{ start: NOW - 9000, end: NOW - 8000 }, { start: NOW - 100, end: NOW + 5000 }, { start: NOW + 90000, end: NOW + 99000 }],
    informedEntity: [{ agencyId: "MTASBWY", routeId: "1", stopId: "127" }, { agencyId: "MTASBWY", routeId: "1", stopId: "127N" }, { agencyId: "MTASBWY", routeId: "1", stopId: "ghost" }],
    headerText: en("[1] trains skip Times Sq"), descriptionText: en("Use 34 St instead."),
  } },
  { id: "lmm:planned_work:3", alert: { activePeriod: [{ start: NOW + 3600, end: NOW + 7200 }], informedEntity: [{ routeId: "A" }], headerText: en("Tonight") } },
  { id: "lmm:planned_work:4", alert: { activePeriod: [{ start: NOW - 7200, end: NOW - 1 }], informedEntity: [{ routeId: "A" }], headerText: en("Last night") } },
  { id: "lmm:alert:5", alert: { informedEntity: [{ trip: { tripId: "t", routeId: "L" } }], headerText: en("The 8:15 [L] is late") } },
  { id: "lmm:alert:6", alert: { activePeriod: [{ start: NOW - 60 }], informedEntity: [{ routeId: "ZZ" }], headerText: en("New route ZZ is delayed") } },
  { id: "lmm:alert:7", alert: { activePeriod: [{ start: NOW - 60 }], informedEntity: [{ routeId: "A" }] } },
]);
const options: AlertsOptions = {
  now: NOW,
  route: (id) => ({ id, name: `${id} train`, color: "#000000", textColor: "#FFFFFF" }),
  stopName: (id) => ({ "127": "Times Sq-42 St", "127N": "Times Sq-42 St" })[id],
};

describe("computeAlerts", () => {
  it("keeps the alerts in effect now, incidents before planned work, newest first", () => {
    const r = computeAlerts(feed, options);
    expect(r.updatedAt).toBe(NOW - 30);
    expect(r.alerts.map((a) => a.id)).toEqual(["lmm:alert:6", "lmm:alert:1", "lmm:alert:5", "lmm:planned_work:2"]);
  });

  it("returns plain text, the period in effect, and routes and stops with names", () => {
    const [, incident, trip, work] = computeAlerts(feed, options).alerts;
    expect(incident).toEqual({
      id: "lmm:alert:1", planned: false, header: "[A][C] trains are delayed.", description: "",
      routes: [{ id: "A", name: "A train", color: "#000000", textColor: "#FFFFFF" }, { id: "C", name: "C train", color: "#000000", textColor: "#FFFFFF" }],
      stops: [], start: NOW - 600, end: null,
    });
    expect(work).toMatchObject({
      planned: true, header: "[1] trains skip Times Sq", description: "Use 34 St instead.", start: NOW - 100, end: NOW + 5000,
      routes: [{ id: "1" }], stops: [{ id: "127", name: "Times Sq-42 St" }, { id: "127N", name: "Times Sq-42 St" }],
    });
    expect(trip).toMatchObject({ routes: [{ id: "L" }], start: null, end: null });
  });

  it("filters on any informed entity", () => {
    const ids = (match: AlertsOptions["match"]) => computeAlerts(feed, { ...options, match }).alerts.map((a) => a.id);
    expect(ids((r) => r === "A")).toEqual(["lmm:alert:1"]);
    expect(ids((_r, s) => s === "127N")).toEqual(["lmm:planned_work:2"]);
    expect(ids(() => false)).toEqual([]);
  });

  it.each(["subway-alerts", "bus-alerts", "lirr-alerts", "mnr-alerts", "ferry-alert"])("reads the recorded %s feed", (name) => {
    const { alerts, updatedAt } = computeAlerts(decodeFeed(fixture(`${name}.pb`)), { ...options, now: Math.floor(FIXTURE_NOW_MS / 1000) });
    expect(updatedAt).toBeGreaterThan(0);
    if (name !== "ferry-alert") expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(a.header).not.toBe("");
      expect(a.header + a.description).not.toMatch(/<\/?(p|strong|br|a)\b/);
      expect(a.routes.length + a.stops.length).toBeGreaterThan(0);
    }
  });
});

describe("subway alerts and vehicles routes", () => {
  useRouteTestSetup();

  /** Serves the hand-built alerts above. */
  const built = async () => new Response(encodeFeed(feed) as Uint8Array<ArrayBuffer>);
  const alerts = (path: string, fetcher = built) => subwayAlertsHandler({ fetcher, now: () => NOW * 1000 })(get(path, auth));

  it("/subway/alerts returns every alert in effect with names and colors joined in", async () => {
    const fetcher = fixtureFetcher();
    const res = await subwayAlertsHandler({ fetcher, now: () => FIXTURE_NOW_MS })(get("/subway/alerts", auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(ALERTS_CACHE);
    expect(fetcher.calls).toEqual(["subway-alerts"]);
    const body = await res.json();
    expect(body.alerts.length).toBeGreaterThan(0);
    const routes = body.alerts.flatMap((a: { routes: { id: string; color: string }[] }) => a.routes);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) if (SUBWAY_DATA.routes[r.id]) expect(r.color).toBe(SUBWAY_DATA.routes[r.id]!.color);
  });

  it("/subway/alerts filters by route, case insensitively", async () => {
    const body = await (await alerts("/subway/alerts?route=a")).json();
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual(["lmm:alert:1"]);
    expect(body.alerts[0].routes[0]).toEqual({ id: "A", name: "A", color: SUBWAY_DATA.routes.A!.color, textColor: SUBWAY_DATA.routes.A!.textColor });
    expect(body.stop).toBeUndefined();
  });

  it("/subway/alerts for a stop keeps alerts naming it and route-wide ones on its routes", async () => {
    const body = await (await alerts(`/subway/alerts?stop=${encodeURIComponent(TIMES_SQ)}`)).json();
    expect(body.stop).toMatchObject({ id: TIMES_SQ, name: "Times Sq-42 St" });
    // A and C stop in the complex; the L alert names a trip, not a stop here; ZZ is no route of it.
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual(["lmm:alert:1", "lmm:planned_work:2"]);
    expect(body.alerts[1].stops[0]).toEqual({ id: "127", name: "Times Sq-42 St" });
    const bedford = await (await alerts("/subway/alerts?stop=L08")).json();
    expect(bedford.alerts.map((a: { id: string }) => a.id)).toEqual(["lmm:alert:5"]);
    const both = await (await alerts(`/subway/alerts?stop=${encodeURIComponent(TIMES_SQ)}&route=1`)).json();
    expect(both.alerts.map((a: { id: string }) => a.id)).toEqual(["lmm:planned_work:2"]);
  });

  it.each([
    ["/subway/alerts?route=ZZ", 404, "unknown route ZZ"],
    ["/subway/alerts?stop=ZZZ", 404, "unknown stop ZZZ"],
  ])("/subway/alerts rejects %s with %i", async (path, status, error) => {
    const res = await alerts(path);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it("/subway/alerts is 502 and uncached when the feed fails", async () => {
    const res = await alerts("/subway/alerts", async () => new Response("down", { status: 503 }));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "MTA alerts unavailable" });
  });

  const vehicles = (path: string, fail: string[] = []) => {
    const fetcher = fixtureFetcher(fail);
    return { fetcher, res: subwayVehiclesHandler({ fetcher, now: () => FIXTURE_NOW_MS })(get(path, auth)) };
  };

  it("/subway/vehicles lists a route's trains with the stop each is at or heading to", async () => {
    const { fetcher, res } = vehicles("/subway/vehicles?route=l");
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(fetcher.calls).toEqual(["gtfs-l"]);
    const body = await r.json();
    expect(body.route).toEqual({ id: "L", name: "L", color: SUBWAY_DATA.routes.L!.color, textColor: "#FFFFFF" });
    expect(body.vehicles.length).toBeGreaterThan(3);
    for (const v of body.vehicles) {
      expect(Object.keys(v).sort()).toEqual(["direction", "headsign", "status", "stop", "time", "tripId"]);
      expect(["INCOMING_AT", "STOPPED_AT", "IN_TRANSIT_TO"]).toContain(v.status);
      expect(v.stop.id).toMatch(/^L\d\d[NS]$/);
      expect(v.stop.id.endsWith(v.direction)).toBe(true);
    }
    expect(body.vehicles.filter((v: { headsign: string }) => v.headsign).length).toBeGreaterThan(3);
  });

  it.each([
    ["/subway/vehicles", 400, "route is required"],
    ["/subway/vehicles?route=ZZ", 404, "unknown route ZZ"],
  ])("/subway/vehicles rejects %s with %i", async (path, status, error) => {
    const r = await vehicles(path).res;
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({ error });
  });

  it("/subway/vehicles is 502 when the feed fails", async () => {
    expect((await vehicles("/subway/vehicles?route=L", ["gtfs-l"]).res).status).toBe(502);
  });
});

describe("computeSubwayTrains", () => {
  const index = new StationIndex(SUBWAY_DATA);
  const L = SUBWAY_DATA.routes.L!;
  const trains = feedFrom(NOW, [
    { tripUpdate: { trip: { tripId: "south", routeId: "L" }, stopTimeUpdate: [{ stopId: "L08S", arrival: { time: NOW + 60 } }, { stopId: "L29S", arrival: { time: NOW + 900 } }] } },
    { vehicle: { trip: { tripId: "south", routeId: "L" }, currentStatus: 1, stopId: "L08S", timestamp: NOW - 10 } },
    { vehicle: { trip: { tripId: "north", routeId: "L" }, stopId: "L06N", timestamp: NOW - 5 } },
    { vehicle: { trip: { tripId: "stale", routeId: "L" }, stopId: "L03N", timestamp: NOW - VEHICLE_MAX_AGE_S - 1 } },
    { vehicle: { trip: { tripId: "other", routeId: "G" }, stopId: "G22N", timestamp: NOW } },
  ]);

  it("keeps the route's recent trains, northbound first, with headsigns from their trips", () => {
    const r = computeSubwayTrains(L, trains, index, { now: NOW });
    expect(r.updatedAt).toBe(NOW);
    expect(r.vehicles).toEqual([
      { tripId: "north", direction: "N", headsign: "", status: "IN_TRANSIT_TO", stop: { id: "L06N", name: "1 Av" }, time: NOW - 5 },
      { tripId: "south", direction: "S", headsign: SUBWAY_DATA.stops.L29!.name, status: "STOPPED_AT", stop: { id: "L08S", name: "Bedford Av" }, time: NOW - 10 },
    ]);
  });
});
