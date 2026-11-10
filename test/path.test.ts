import { describe, expect, it } from "vitest";
import { LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE } from "../src/http.js";
import { BOARDING_GRACE_S, computePathArrivals, type PathArrivalsResult } from "../src/path/arrivals.js";
import { parsePathFeed, PATH_FEED_URL } from "../src/path/feed.js";
import { pathPreviewLine } from "../src/path/preview.js";
import { PATH_ROUTES, PATH_STATIONS, pathStation, routeForColors, searchPathStations } from "../src/path/stations.js";
import { pathArrivalsHandler, pathPreviewHandler, pathStationsHandler } from "../src/routes/path.js";
import { auth, fixture, fixtureFetcher, get, PATH_FIXTURE_NOW_MS, useRouteTestSetup } from "./helpers.js";

const NOW = 1_000_000;
const UPDATED = "1970-01-12T13:46:40Z"; // NOW

interface Msg { seconds: number | string; headSign: string; lineColor: string; lastUpdated?: string }
function doc(station: string, destinations: Record<string, Msg[]>) {
  return {
    results: [{
      consideredStation: station,
      destinations: Object.entries(destinations).map(([label, messages]) => ({
        label,
        messages: messages.map((m) => ({
          target: "X", secondsToArrival: String(m.seconds), arrivalTimeMessage: "", lineColor: m.lineColor,
          headSign: m.headSign, lastUpdated: m.lastUpdated ?? UPDATED,
        })),
      })),
    }],
  };
}
const GRV = pathStation("GRV")!;

describe("PATH stations", () => {
  it("lists 13 stations whose routes all exist", () => {
    expect(PATH_STATIONS).toHaveLength(13);
    const ids = new Set(PATH_ROUTES.map((r) => r.id));
    for (const s of PATH_STATIONS) for (const r of s.routes) expect(ids.has(r), `${s.id} ${r}`).toBe(true);
  });

  it("resolves ids case insensitively", () => {
    expect(pathStation(" wtc ")?.name).toBe("World Trade Center");
    expect(pathStation("09s")?.name).toBe("9th Street");
    expect(pathStation("ZZZ")).toBeUndefined();
  });

  it.each([
    ["wtc", "WTC"], ["world trade", "WTC"], ["9th st", "09S"], ["33rd street", "33S"], ["journal sq", "JSQ"],
    ["jsq", "JSQ"], ["grove", "GRV"], ["Newark Penn", "NWK"], ["hoboken", "HOB"], ["new", "NEW"],
  ])("finds %s", (q, id) => {
    expect(searchPathStations(q)[0]?.id).toBe(id);
  });

  it("finds nothing for no match", () => {
    expect(searchPathStations("zzzz")).toEqual([]);
    expect(searchPathStations(" ")).toEqual([]);
  });

  it("maps the feed's line colors to routes, including the two-color night line", () => {
    const feed = parsePathFeed(doc("HOB", { ToNY: [{ seconds: 60, headSign: "33rd Street", lineColor: "ff9900,4D92FB" }] }));
    expect(routeForColors(feed.stations.HOB![0]!.colors)?.id).toBe("JSQ-33-HOB");
    expect(routeForColors("D93A30")?.id).toBe("NWK-WTC");
    expect(routeForColors("123456")).toBeUndefined();
  });
});

describe("parsePathFeed", () => {
  it("adds secondsToArrival to each message's own lastUpdated", () => {
    const feed = parsePathFeed(doc("GRV", {
      ToNY: [{ seconds: "88", headSign: "33rd Street", lineColor: "FF9900", lastUpdated: "2026-11-10T09:18:17.53649-05:00" }],
    }));
    expect(feed).toEqual({
      skipped: 0,
      stations: { GRV: [{ direction: "NY", headsign: "33rd Street", colors: "FF9900", time: 1794320297 + 88, updatedAt: 1794320297 }] },
    });
  });

  it("counts and skips entries it can't read, and keeps a station with no trains", () => {
    const feed = parsePathFeed({
      results: [
        ...doc("GRV", {
          ToNY: [
            { seconds: "soon", headSign: "33rd Street", lineColor: "FF9900" },
            { seconds: 60, headSign: "33rd Street", lineColor: "FF9900", lastUpdated: "yesterday" },
            { seconds: 90, headSign: "33rd Street", lineColor: "FF9900" },
          ],
          Sideways: [{ seconds: 60, headSign: "Nowhere", lineColor: "FF9900" }],
        }).results,
        { consideredStation: "HAR", destinations: [] },
        { destinations: [] },
      ],
    });
    expect(feed.skipped).toBe(4);
    expect(feed.stations.GRV).toHaveLength(1);
    expect(feed.stations.HAR).toEqual([]);
  });

  it("throws on a document that isn't the feed", () => {
    expect(() => parsePathFeed({ error: "nope" })).toThrow(/no results/);
    expect(() => parsePathFeed(null)).toThrow(/no results/);
  });

  it("reads the recorded feed completely", () => {
    const feed = parsePathFeed(JSON.parse(Buffer.from(fixture("ridepath.json")).toString()));
    expect(feed.skipped).toBe(0);
    expect(Object.keys(feed.stations).sort()).toEqual(PATH_STATIONS.map((s) => s.id).sort());
    const trains = Object.values(feed.stations).flat();
    expect(trains.length).toBeGreaterThan(20);
    for (const t of trains) {
      expect(routeForColors(t.colors), t.colors).toBeDefined();
      expect(t.headsign).not.toBe("");
      expect(Math.abs(t.updatedAt - PATH_FIXTURE_NOW_MS / 1000)).toBeLessThan(600);
    }
  });
});

describe("computePathArrivals", () => {
  const feed = parsePathFeed(doc("GRV", {
    ToNJ: [
      { seconds: 400, headSign: "Newark", lineColor: "D93A30" },
      { seconds: 50, headSign: "Journal Square", lineColor: "FF9900" },
      { seconds: 100, headSign: "Newark", lineColor: "D93A30" },
    ],
    ToNY: [
      { seconds: 0, headSign: "33rd Street", lineColor: "FF9900", lastUpdated: "1970-01-12T13:45:40Z" },
      { seconds: 300, headSign: "World Trade Center", lineColor: "D93A30" },
      { seconds: 700, headSign: "World Trade Center", lineColor: "D93A30" },
    ],
  }));

  it("groups by route and direction in PATH's order, toward New York first, soonest first", () => {
    const r = computePathArrivals(GRV, feed, { now: NOW, limit: 3 });
    expect(r.station).toEqual({ id: "GRV", name: "Grove Street" });
    expect(r.updatedAt).toBe(NOW - 60);
    expect(r.groups.map((g) => [g.route, g.direction, g.headsign, g.arrivals.map((a) => a.time - NOW)])).toEqual([
      ["NWK-WTC", "NY", "World Trade Center", [300, 700]],
      ["NWK-WTC", "NJ", "Newark", [100, 400]],
      ["JSQ-33", "NY", "33rd Street", [-60]],
      ["JSQ-33", "NJ", "Journal Square", [50]],
    ]);
    expect(r.groups[0]).toMatchObject({ name: "Newark - World Trade Center", color: "#D93A30", textColor: "#FFFFFF" });
  });

  it("keeps limit trains per group", () => {
    const r = computePathArrivals(GRV, feed, { now: NOW, limit: 1 });
    expect(r.groups.map((g) => g.arrivals.length)).toEqual([1, 1, 1, 1]);
  });

  it("keeps a train at the platform for a while, then drops it", () => {
    const routes = (now: number) => computePathArrivals(GRV, feed, { now, limit: 3 }).groups.map((g) => `${g.route} ${g.direction}`);
    expect(routes(NOW - 60 + BOARDING_GRACE_S)).toContain("JSQ-33 NY");
    expect(routes(NOW - 60 + BOARDING_GRACE_S + 1)).not.toContain("JSQ-33 NY");
    expect(computePathArrivals(GRV, feed, { now: NOW + 3600, limit: 3 }).groups).toEqual([]);
  });

  it("shows a line color it doesn't know under that color", () => {
    const odd = parsePathFeed(doc("GRV", { ToNY: [{ seconds: 60, headSign: "33rd Street", lineColor: "123abc" }] }));
    expect(computePathArrivals(GRV, odd, { now: NOW, limit: 3 }).groups[0]).toMatchObject({ route: "123ABC", name: "PATH", color: "#123ABC" });
  });

  it("answers no groups and a null updatedAt for a station the feed leaves out", () => {
    expect(computePathArrivals(pathStation("HAR")!, feed, { now: NOW, limit: 3 })).toEqual({
      station: { id: "HAR", name: "Harrison" }, updatedAt: null, groups: [],
    });
  });
});

describe("pathPreviewLine", () => {
  const line = (destinations: Record<string, Msg[]>) =>
    pathPreviewLine(computePathArrivals(GRV, parsePathFeed(doc("GRV", destinations)), { now: NOW, limit: 1 }), NOW);

  it("lists the next train to each destination, soonest first, rounded down", () => {
    expect(line({
      ToNJ: [{ seconds: 299, headSign: "Newark", lineColor: "D93A30" }, { seconds: 61, headSign: "Journal Square", lineColor: "FF9900" }],
      ToNY: [{ seconds: 150, headSign: "33rd Street", lineColor: "FF9900" }],
    })).toBe("Grove Street · Journal Square 1 · 33rd Street 2 · Newark 4 min");
  });

  it("keeps the sooner of two routes to the same place and shows a boarding train as 0", () => {
    expect(line({
      ToNY: [
        { seconds: 500, headSign: "World Trade Center", lineColor: "D93A30" },
        { seconds: 0, headSign: "World Trade Center", lineColor: "65C100", lastUpdated: "1970-01-12T13:46:00Z" },
      ],
    })).toBe("Grove Street · World Trade Center 0 min");
  });

  it("says so when no train is coming", () => {
    const none: PathArrivalsResult = { station: { id: "GRV", name: "Grove Street" }, updatedAt: null, groups: [] };
    expect(pathPreviewLine(none, NOW)).toBe("Grove Street · no trains soon");
  });
});

describe("PATH routes", () => {
  useRouteTestSetup();

  const deps = (fetcher = fixtureFetcher()) => ({ fetcher, now: () => PATH_FIXTURE_NOW_MS });

  it("/path/arrivals returns pre-joined arrivals with live cache headers", async () => {
    const d = deps();
    const res = await pathArrivalsHandler(d)(get("/path/arrivals?station=jsq&limit=2", auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(d.fetcher.calls).toEqual(["ridepath.json"]);
    const body = await res.json();
    expect(body.station).toEqual({ id: "JSQ", name: "Journal Square" });
    expect(body.updatedAt).toBeTypeOf("number");
    const keys: string[] = body.groups.map((g: { route: string; direction: string }) => `${g.route} ${g.direction}`);
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys) expect(["NWK-WTC NY", "NWK-WTC NJ", "JSQ-33 NY", "JSQ-33-HOB NY"]).toContain(k);
    for (const g of body.groups) {
      expect(Object.keys(g).sort()).toEqual(["arrivals", "color", "direction", "headsign", "name", "route", "textColor"]);
      expect(g.arrivals.length).toBeGreaterThan(0);
      expect(g.arrivals.length).toBeLessThanOrEqual(2);
      expect(Object.keys(g.arrivals[0]).sort()).toEqual(["headsign", "time"]);
    }
  });

  it("fetches the feed once for different stations within the in-function window", async () => {
    const d = deps();
    const GET = pathArrivalsHandler(d);
    await GET(get("/path/arrivals?station=WTC", auth));
    await GET(get("/path/arrivals?station=HOB", auth));
    expect(d.fetcher.calls).toHaveLength(1);
  });

  it("asks the Port Authority for JSON", async () => {
    const seen: [string, RequestInit][] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push([url, init]);
      return new Response(fixture("ridepath.json"));
    };
    await pathArrivalsHandler({ fetcher, now: () => PATH_FIXTURE_NOW_MS })(get("/path/arrivals?station=WTC", auth));
    expect(seen[0]![0]).toBe(PATH_FEED_URL);
    expect(seen[0]![1].headers).toEqual({ accept: "application/json" });
  });

  it.each([
    ["", 400, "station is required"],
    ["?station=ZZZ", 404, "unknown station ZZZ"],
    ["?station=WTC&limit=0", 400, "limit must be a positive integer"],
  ])("/path/arrivals rejects %s with %i", async (query, status, error) => {
    const res = await pathArrivalsHandler(deps())(get(`/path/arrivals${query}`, auth));
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error });
  });

  it.each([
    ["an upstream error", async () => new Response("down", { status: 503 })],
    ["HTML instead of JSON", async () => new Response("<html>blocked</html>")],
    ["JSON that isn't the feed", async () => new Response("{}")],
  ])("is 502 and uncached on %s, and retries on the next request", async (_what, bad) => {
    let fail = true;
    const good = fixtureFetcher();
    const GET = pathArrivalsHandler({ fetcher: (url, init) => (fail ? bad() : good(url, init)), now: () => PATH_FIXTURE_NOW_MS });
    const res = await GET(get("/path/arrivals?station=WTC", auth));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "PATH feed unavailable" });
    expect((await pathPreviewHandler({ fetcher: bad, now: () => PATH_FIXTURE_NOW_MS })(get("/preview/path?q=wtc", auth))).status).toBe(502);
    fail = false;
    expect((await GET(get("/path/arrivals?station=WTC", auth))).status).toBe(200);
  });

  it("/path/stations lists the stations with their routes joined in", async () => {
    const res = await pathStationsHandler()(get("/path/stations", auth));
    expect(res.headers.get("cache-control")).toBe(STATIC_CACHE);
    const body = await res.json();
    expect(body.stations).toHaveLength(13);
    expect(body.stations[0]).toEqual({
      id: "NWK", name: "Newark",
      routes: [{ id: "NWK-WTC", name: "Newark - World Trade Center", color: "#D93A30", textColor: "#FFFFFF" }],
    });
  });

  it("/preview/path answers one line of text for a station name or id", async () => {
    const GET = pathPreviewHandler(deps());
    const res = await GET(get("/preview/path?q=grove%20st", auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe(PREVIEW_CACHE);
    // Whatever the recording holds: two to five destinations, soonest first.
    const line = await res.text();
    expect(line).toMatch(/^Grove Street( · [A-Z0-9][A-Za-z0-9 ]+ \d+){2,5} min\n$/);
    const minutes = [...line.matchAll(/ (\d+)(?= ·| min)/g)].map((m) => Number(m[1]));
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
    const byId = await GET(get("/preview/path?station=grv", auth));
    expect(await byId.text()).toMatch(/^Grove Street · /);
  });

  it.each([
    ["", 400, "q or station is required"],
    ["?q=zzzz", 404, "no matching station"],
    ["?station=ZZZ", 404, "unknown station ZZZ"],
  ])("/preview/path rejects %s with %i as uncached JSON", async (query, status, error) => {
    const res = await pathPreviewHandler(deps())(get(`/preview/path${query}`, auth));
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error });
  });
});
