import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGbfsMemo, fetchGbfs, parseGbfs, type GbfsFeed, type GbfsStationInformation, type GbfsStationStatus } from "../src/citibike/feeds.js";
import { distanceMeters, joinStations, nearestStations } from "../src/citibike/stations.js";
import { citibikeNearbyHandler, citibikeStationHandler } from "../src/routes/citibike.js";
import { LIVE_CACHE } from "../src/http.js";
import { citibikeFetcher, fixture, get, TOKEN } from "./helpers.js";

const auth = { "x-transit-token": TOKEN };
const NOW_MS = 1794322409_000;
/** In the recorded feeds: a busy station, and one that is listed but not on the street. */
const W40_7AV = "f72a253f-3cef-4da8-9591-0cbd3a692162";
const NOT_INSTALLED = "66dc292c-0aca-11e7-82f6-3863bb44ef7c";
const TIMES_SQ = "lat=40.7559&lon=-73.9871";

beforeEach(() => {
  vi.stubEnv("TRANSIT_TOKEN", TOKEN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  clearGbfsMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function information(stations: Partial<GbfsStationInformation>[]): GbfsFeed<GbfsStationInformation> {
  return {
    last_updated: 100,
    data: { stations: stations.map((s, i) => ({ station_id: String(i), name: `Station ${i}`, lat: 40.7, lon: -74, capacity: 20, ...s })) },
  };
}
function status(stations: Partial<GbfsStationStatus>[], last_updated = 200): GbfsFeed<GbfsStationStatus> {
  return {
    last_updated,
    data: { stations: stations.map((s, i) => ({ station_id: String(i), is_installed: 1, is_renting: 1, is_returning: 1, ...s })) },
  };
}

describe("joinStations", () => {
  it("splits classic bikes from e-bikes and takes its timestamp from the status feed", () => {
    const joined = joinStations(
      information([{ name: "W 40 St & 7 Ave", lat: 40.75, lon: -73.99, capacity: 45 }]),
      status([{ num_bikes_available: 12, num_ebikes_available: 4, num_docks_available: 3, last_reported: 1794322147 }]),
    );
    expect(joined.updatedAt).toBe(200);
    expect([...joined.byId.values()]).toEqual([
      {
        id: "0", name: "W 40 St & 7 Ave", lat: 40.75, lon: -73.99, capacity: 45,
        bikes: 8, ebikes: 4, docks: 3, renting: true, returning: true, reportedAt: 1794322147,
      },
    ]);
  });

  it("never reports more e-bikes than bikes, and reads missing counts as zero", () => {
    const { byId } = joinStations(information([{}, {}]), status([{ num_bikes_available: 2, num_ebikes_available: 5 }, {}]));
    expect(byId.get("0")).toMatchObject({ bikes: 0, ebikes: 2, docks: 0 });
    expect(byId.get("1")).toMatchObject({ bikes: 0, ebikes: 0, docks: 0 });
  });

  it("leaves out stations that aren't installed or have no status", () => {
    const { byId } = joinStations(information([{}, {}, {}]), status([{ is_installed: 0 }, { station_id: "elsewhere" }, {}]));
    expect([...byId.keys()]).toEqual(["2"]);
  });

  it("keeps a closed station, flagged, and accepts spec booleans", () => {
    const { byId } = joinStations(
      information([{}, {}]),
      status([{ is_renting: 0, is_returning: 0, last_reported: 86400 }, { is_installed: true, is_renting: true, is_returning: false }]),
    );
    expect(byId.get("0")).toMatchObject({ renting: false, returning: false });
    expect(byId.get("0")).not.toHaveProperty("reportedAt");
    expect(byId.get("1")).toMatchObject({ renting: true, returning: false });
  });
});

describe("nearestStations", () => {
  it("measures great-circle meters", () => {
    // Times Sq to Union Sq is about 2.4 km.
    expect(distanceMeters(40.7559, -73.9871, 40.7359, -73.9906)).toBeGreaterThan(2200);
    expect(distanceMeters(40.7559, -73.9871, 40.7359, -73.9906)).toBeLessThan(2300);
    expect(distanceMeters(40.7, -74, 40.7, -74)).toBe(0);
  });

  it("returns the n closest, nearest first, ties by id", () => {
    const { byId } = joinStations(
      information([{ lat: 40.72 }, { lat: 40.701 }, { lat: 40.71 }, { lat: 40.701 }]),
      status([{}, {}, {}, {}]),
    );
    const near = nearestStations(byId.values(), 40.7, -74, 3);
    expect(near.map((s) => s.id)).toEqual(["1", "3", "2"]);
    expect(near[0]!.distance).toBe(111);
  });
});

describe("recorded Citi Bike feeds", () => {
  const feed = <T>(name: string) => parseGbfs<T>(name, JSON.parse(new TextDecoder().decode(fixture(`citibike-${name}.json`))));
  const joined = joinStations(feed("station_information"), feed("station_status"));

  it("join into stations with sane counts", () => {
    expect(joined.updatedAt).toBe(NOW_MS / 1000);
    expect(joined.byId.size).toBe(36);
    expect(joined.byId.has(NOT_INSTALLED)).toBe(false);
    for (const s of joined.byId.values()) {
      expect(s.name).not.toBe("");
      expect(s.capacity).toBeGreaterThan(0);
      expect(s.bikes + s.ebikes + s.docks).toBeLessThanOrEqual(s.capacity);
      expect(Math.abs(NOW_MS / 1000 - s.reportedAt!)).toBeLessThan(86400);
    }
    expect(joined.byId.get(W40_7AV)).toEqual({
      id: W40_7AV, name: "W 40 St & 7 Ave", lat: 40.754818, lon: -73.988154, capacity: 45,
      bikes: 9, ebikes: 28, docks: 2, renting: true, returning: true, reportedAt: 1794322384,
    });
  });

  it("rejects a body that isn't a station feed", () => {
    expect(() => parseGbfs("station_status", { data: {} })).toThrow(/not a GBFS station feed/);
    expect(() => parseGbfs("station_status", null)).toThrow(/not a GBFS station feed/);
  });
});

describe.each([
  ["/citibike/station", `?id=${W40_7AV}`, () => citibikeStationHandler({ fetcher: citibikeFetcher(), now: () => NOW_MS })],
  ["/citibike/nearby", `?${TIMES_SQ}`, () => citibikeNearbyHandler({ fetcher: citibikeFetcher(), now: () => NOW_MS })],
])("%s auth and caching", (path, query, handler) => {
  it("is 401 without a token or with a wrong one, uncached and varying on the token header", async () => {
    const res = await handler()(get(path + query));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("x-transit-token");
    expect(await res.json()).toEqual({ error: "missing token" });
    expect((await handler()(get(path + query, { "x-transit-token": "nope" }))).status).toBe(401);
  });

  it("returns a CDN-cacheable answer keyed by the token header", async () => {
    const res = await handler()(get(path + query, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(res.headers.get("vary")).toBe("x-transit-token");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(["station_information", "station_status"])("is 502 and uncached when %s is down", async (feed) => {
    const GET = path.endsWith("station")
      ? citibikeStationHandler({ fetcher: citibikeFetcher([feed]), now: () => NOW_MS })
      : citibikeNearbyHandler({ fetcher: citibikeFetcher([feed]), now: () => NOW_MS });
    const res = await GET(get(path + query, auth));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("x-transit-token");
    expect(await res.json()).toEqual({ error: "Citi Bike feeds unavailable" });
  });
});

describe("/citibike/station", () => {
  const handler = (fetcher = citibikeFetcher()) => citibikeStationHandler({ fetcher, now: () => NOW_MS });

  it("returns one station with its name and counts", async () => {
    const res = await handler()(get(`/citibike/station?id=${W40_7AV.toUpperCase()}`, auth));
    expect(await res.json()).toEqual({
      updatedAt: 1794322409,
      station: {
        id: W40_7AV, name: "W 40 St & 7 Ave", lat: expect.any(Number), lon: expect.any(Number), capacity: 45,
        bikes: 9, ebikes: 28, docks: 2, renting: true, returning: true, reportedAt: 1794322384,
      },
    });
  });

  it("is 400 without an id and 404 for an unknown or uninstalled station", async () => {
    const GET = handler();
    expect((await GET(get("/citibike/station", auth))).status).toBe(400);
    for (const id of ["nope", NOT_INSTALLED]) {
      const res = await GET(get(`/citibike/station?id=${id}`, auth));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: `unknown station ${id}` });
    }
  });
});

describe("/citibike/nearby", () => {
  const handler = (fetcher = citibikeFetcher()) => citibikeNearbyHandler({ fetcher, now: () => NOW_MS });

  it("returns the closest installed stations, nearest first, 5 by default", async () => {
    const body = await (await handler()(get(`/citibike/nearby?${TIMES_SQ}`, auth))).json();
    expect(body).toMatchObject({ lat: 40.7559, lon: -73.9871, updatedAt: 1794322409 });
    expect(body.stations.map((s: { name: string }) => s.name)).toEqual([
      "W 40 St & 7 Ave", "W 42 St & 6 Ave", "W 41 St & 8 Ave", "Broadway & W 38 St", "W 43 St & 6 Ave",
    ]);
    expect(body.stations[0]).toMatchObject({ id: W40_7AV, distance: 150, bikes: 9, ebikes: 28, docks: 2 });
    const distances = body.stations.map((s: { distance: number }) => s.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("honors n and caps it at 25", async () => {
    const GET = handler();
    expect((await (await GET(get(`/citibike/nearby?${TIMES_SQ}&n=2`, auth))).json()).stations).toHaveLength(2);
    expect((await (await GET(get(`/citibike/nearby?${TIMES_SQ}&n=500`, auth))).json()).stations).toHaveLength(25);
  });

  it.each([
    ["", "lat is required"],
    ["?lat=40.7", "lon is required"],
    ["?lat=north&lon=-74", "lat must be a number between -90 and 90"],
    ["?lat=91&lon=-74", "lat must be a number between -90 and 90"],
    ["?lat=40.7&lon=-181", "lon must be a number between -180 and 180"],
    ["?lat=40.7&lon=-74&n=0", "n must be a positive integer"],
  ])("is 400 for %s", async (query, error) => {
    const res = await handler()(get(`/citibike/nearby${query}`, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });
});

describe("fetchGbfs", () => {
  it("keeps the station list longer than the live status", async () => {
    const fetcher = citibikeFetcher();
    const GET = citibikeStationHandler({ fetcher, now: () => NOW_MS });
    await GET(get(`/citibike/station?id=${W40_7AV}`, auth));
    await citibikeNearbyHandler({ fetcher, now: () => NOW_MS + 10_000 })(get(`/citibike/nearby?${TIMES_SQ}`, auth));
    expect(fetcher.calls.sort()).toEqual(["station_information", "station_status"]);
    await citibikeStationHandler({ fetcher, now: () => NOW_MS + 60_000 })(get(`/citibike/station?id=${W40_7AV}`, auth));
    expect(fetcher.calls.sort()).toEqual(["station_information", "station_status", "station_status"]);
  });

  it("falls back to the previous station list when its refresh fails, and retries next time", async () => {
    const fetcher = citibikeFetcher();
    const first = await fetchGbfs("station_information", { fetcher, now: NOW_MS });
    fetcher.fail.push("station_information");
    const later = NOW_MS + 3_600_000;
    expect(await fetchGbfs("station_information", { fetcher, now: later })).toBe(first);
    await fetchGbfs("station_information", { fetcher, now: later + 1 });
    expect(fetcher.calls).toHaveLength(3);
    await expect(fetchGbfs("station_status", { fetcher: citibikeFetcher(["station_status"]), now: later })).rejects.toThrow(/HTTP 503/);
  });
});
