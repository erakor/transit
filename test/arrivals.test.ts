import { describe, expect, it } from "vitest";
import { SUBWAY_DATA } from "#src/data/subway.generated.js";
import { StationIndex } from "#src/stops/stations.js";
import { computeArrivals } from "#src/subway/arrivals.js";
import { decodeFeed } from "#src/gtfsrt.js";
import { FEEDS, feedsForRoutes } from "#src/subway/feeds.js";
import { fixture, FIXTURE_NOW_MS } from "./helpers.js";
import { makeFeed } from "./feed.js";

const index = new StationIndex(SUBWAY_DATA);
const NOW = 1_800_000_000;

describe("computeArrivals on a built feed", () => {
  const feed = makeFeed(NOW - 5, [
    { id: "t1", route: "1", stops: [["126N", NOW + 30], ["127N", NOW + 120], ["101N", NOW + 2400]] },
    { id: "t2", route: "1", stops: [["127N", NOW + 60], ["103N", NOW + 2000]] },
    { id: "t3", route: "1", stops: [["127N", NOW - 60], ["101N", NOW + 1500]] },
    { id: "t4", route: "1", stops: [["127N", NOW + 500], ["101N", NOW + 2900]] },
    { id: "t5", route: "2", stops: [["127S", NOW + 90], ["127N", NOW + 95], ["247S", NOW + 3000]] },
    { id: "t6", route: "A", stops: [["A27S", NOW + 200], ["A55S", NOW + 3000]] },
    { id: "t7", route: "3", stops: [["127S", NOW + 100], ["148S", NOW + 900]], skipped: ["127S"] },
    { id: "t8", route: "Q", stops: [["R16S", NOW + 300], ["D43S", NOW + 3000]] },
  ]);

  it("groups by route and direction, sorted by time, past and skipped stops dropped", () => {
    const stop = index.resolve("127")!;
    const r = computeArrivals(stop, [feed], index, { now: NOW, limit: 2 });
    expect(r.stop).toEqual({ id: "127", name: "Times Sq-42 St", stops: ["127"] });
    expect(r.updatedAt).toBe(NOW - 5);
    expect(r.groups.map((g) => `${g.route}${g.direction}:${g.arrivals.map((a) => a.tripId).join(",")}`)).toEqual([
      "1N:t2,t1",
      "2N:t5",
      "2S:t5",
    ]);
    const g = r.groups[0]!;
    expect(g).toMatchObject({ name: "1", color: SUBWAY_DATA.routes["1"]!.color, headsign: SUBWAY_DATA.stops["103"]!.name });
    expect(g.arrivals[1]).toEqual({ time: NOW + 120, headsign: "Van Cortlandt Park-242 St", tripId: "t1" });
  });

  it("covers every stop of a station complex", () => {
    const stop = index.resolve(SUBWAY_DATA.stops["127"]!.station)!;
    const r = computeArrivals(stop, [feed], index, { now: NOW, limit: 3 });
    expect(r.groups.map((g) => g.route + g.direction)).toEqual(["AS", "1N", "2N", "2S", "QS"].sort((a, b) =>
      (SUBWAY_DATA.routes[a[0]!]!.sortOrder - SUBWAY_DATA.routes[b[0]!]!.sortOrder) || a.localeCompare(b)));
    expect(r.groups.find((g) => g.route === "1")!.arrivals.map((a) => a.tripId)).toEqual(["t2", "t1", "t4"]);
  });

  it("limits to one platform when given a platform id", () => {
    const r = computeArrivals(index.resolve("127s")!, [feed], index, { now: NOW, limit: 3 });
    expect(r.stop.id).toBe("127S");
    expect(r.groups.map((g) => g.route + g.direction)).toEqual(["2S"]);
  });
});

describe("computeArrivals on recorded MTA feeds", () => {
  const now = Math.floor(FIXTURE_NOW_MS / 1000);
  for (const name of Object.keys(FEEDS)) {
    it(`parses ${name} into upcoming arrivals with known routes`, () => {
      const feed = decodeFeed(fixture(`${name}.pb`));
      const stations = SUBWAY_DATA.stations.filter((s) => s.routes.some((r) => FEEDS[name]!.includes(r)));
      let total = 0;
      for (const s of stations) {
        const r = computeArrivals(index.resolve(s.id)!, [feed], index, { now, limit: 3 });
        for (const g of r.groups) {
          expect(FEEDS[name]).toContain(g.route);
          expect(g.color).toMatch(/^#[0-9A-F]{6}$/);
          expect(g.arrivals.length).toBeGreaterThan(0);
          expect(g.arrivals.length).toBeLessThanOrEqual(3);
          for (const a of g.arrivals) {
            expect(a.time).toBeGreaterThanOrEqual(now);
            expect(a.time).toBeLessThan(now + 6 * 3600);
            expect(a.headsign).not.toBe("");
          }
          total += g.arrivals.length;
        }
      }
      expect(total).toBeGreaterThan(0);
    });
  }
});

describe("feedsForRoutes", () => {
  it("maps routes to the feeds that carry them", () => {
    expect(feedsForRoutes(["A", "1", "N", "7X", "Nope"])).toEqual(["gtfs", "gtfs-ace", "gtfs-nqrw"]);
  });
  it("covers every route in the static data", () => {
    const covered = new Set(Object.values(FEEDS).flat());
    expect(Object.keys(SUBWAY_DATA.routes).filter((r) => !covered.has(r))).toEqual([]);
  });
});
