import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as healthGET } from "../api/health.js";
import { arrivalsHandler } from "../src/routes/arrivals.js";
import { searchHandler } from "../src/routes/search.js";
import { clearFeedMemo } from "../src/subway/feeds.js";
import { LIVE_CACHE, STATIC_CACHE } from "../src/http.js";
import { SUBWAY_DATA } from "../src/data/subway.generated.js";
import { fixtureFetcher, FIXTURE_NOW_MS, get, TOKEN } from "./helpers.js";

const auth = { "x-transit-token": TOKEN };
const TIMES_SQ = SUBWAY_DATA.stops["127"]!.station;

beforeEach(() => {
  vi.stubEnv("TRANSIT_TOKEN", TOKEN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  clearFeedMemo();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function arrivals(fetcher = fixtureFetcher(), nowMs = FIXTURE_NOW_MS) {
  return { fetcher, GET: arrivalsHandler({ fetcher, now: () => nowMs }) };
}

describe("/health", () => {
  it("needs no token and is never cached", async () => {
    const res = await healthGET(get("/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, staticFeedVersion: SUBWAY_DATA.feedVersion });
  });
});

describe.each([
  ["/subway/arrivals", `?stop=${encodeURIComponent(TIMES_SQ)}`, () => arrivals().GET],
  ["/stops/search", "?q=times", () => searchHandler()],
])("%s auth and caching", (path, query, handler) => {
  it("is 401 without a token, uncached and varying on the token header", async () => {
    const res = await handler()(get(path + query));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("x-transit-token");
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toEqual({ error: "missing token" });
  });

  it("is 401 with a wrong token", async () => {
    const res = await handler()(get(path + query, { "x-transit-token": "nope" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid token" });
  });

  it("is 500 when the server has no token configured", async () => {
    vi.stubEnv("TRANSIT_TOKEN", "");
    const res = await handler()(get(path + query, auth));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns CDN-cacheable JSON keyed by the token header", async () => {
    const res = await handler()(get(path + query, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toMatch(/^public, s-maxage=\d+, stale-while-revalidate=\d+$/);
    expect(res.headers.get("vary")).toBe("x-transit-token");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts Authorization: Bearer too", async () => {
    const res = await handler()(get(path + query, { authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
  });
});

describe("/subway/arrivals", () => {
  it("returns pre-joined arrivals for a station complex with live cache headers", async () => {
    const { GET, fetcher } = arrivals();
    const res = await GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}&limit=2`, auth));
    expect(res.headers.get("cache-control")).toBe(LIVE_CACHE);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=20, stale-while-revalidate=40");
    expect(fetcher.calls.sort()).toEqual(["gtfs", "gtfs-ace", "gtfs-nqrw"]);
    const body = await res.json();
    expect(body.stop).toMatchObject({ id: TIMES_SQ, name: "Times Sq-42 St" });
    expect(body.updatedAt).toBeTypeOf("number");
    expect(body.groups.length).toBeGreaterThan(4);
    for (const g of body.groups) {
      expect(Object.keys(g).sort()).toEqual(["arrivals", "color", "direction", "headsign", "name", "route", "textColor"]);
      expect(g.arrivals.length).toBeLessThanOrEqual(2);
    }
    expect(body.unavailableFeeds).toBeUndefined();
  });

  it("accepts a plain stop id and only fetches the feeds it needs", async () => {
    const { GET, fetcher } = arrivals();
    const res = await GET(get("/subway/arrivals?stop=L08", auth));
    expect(res.status).toBe(200);
    expect(fetcher.calls).toEqual(["gtfs-l"]);
    const body = await res.json();
    expect(body.stop).toMatchObject({ id: "L08", name: "Bedford Av" });
    expect(new Set(body.groups.map((g: { route: string }) => g.route))).toEqual(new Set(["L"]));
  });

  it("reuses fetched feeds within the in-function window", async () => {
    const { GET, fetcher } = arrivals();
    await GET(get("/subway/arrivals?stop=L08", auth));
    await GET(get("/subway/arrivals?stop=L06", auth));
    expect(fetcher.calls).toEqual(["gtfs-l"]);
  });

  it("returns what it has when some feeds fail, with a short cache", async () => {
    const { GET } = arrivals(fixtureFetcher(["gtfs-ace"]));
    const res = await GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}`, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=5");
    const body = await res.json();
    expect(body.unavailableFeeds).toEqual(["gtfs-ace"]);
    expect(body.groups.some((g: { route: string }) => g.route === "A")).toBe(false);
    expect(body.groups.some((g: { route: string }) => g.route === "1")).toBe(true);
  });

  it("is 502 when every feed fails", async () => {
    const { GET } = arrivals(fixtureFetcher(["gtfs-l"]));
    const res = await GET(get("/subway/arrivals?stop=L08", auth));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["", 400, "stop is required"],
    ["?stop=", 400, "stop is required"],
    ["?stop=ZZZ", 404, "unknown stop ZZZ"],
    ["?stop=L08&limit=0", 400, "limit must be a positive integer"],
    ["?stop=L08&limit=abc", 400, "limit must be a positive integer"],
  ])("rejects %s with %i", async (query, status, error) => {
    const res = await arrivals().GET(get(`/subway/arrivals${query}`, auth));
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error });
  });

  it("caps limit at 10", async () => {
    const res = await arrivals().GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}&limit=99`, auth));
    const body = await res.json();
    expect(Math.max(...body.groups.map((g: { arrivals: unknown[] }) => g.arrivals.length))).toBeLessThanOrEqual(10);
  });
});

describe("/stops/search", () => {
  async function search(q: string, extra = "") {
    const res = await searchHandler()(get(`/stops/search?q=${encodeURIComponent(q)}${extra}`, auth));
    return { res, body: await res.json() };
  }

  it("finds stations case and accent insensitively, with ids usable by /subway/arrivals", async () => {
    for (const q of ["times sq", "TIMES SQUARE", "Tímes Sq", "42nd street times"]) {
      const { body } = await search(q);
      expect(body.results[0].id, q).toBe(TIMES_SQ);
    }
    const { res, body } = await search("bedford av");
    expect(res.headers.get("cache-control")).toBe(STATIC_CACHE);
    const hit = body.results.find((r: { name: string }) => r.name === "Bedford Av");
    expect(hit).toMatchObject({ id: "L08", stops: [{ id: "L08", name: "Bedford Av" }] });
    expect(hit.routes).toEqual([{ id: "L", name: "L", color: SUBWAY_DATA.routes["L"]!.color, textColor: "#FFFFFF" }]);
    const arr = await arrivals().GET(get(`/subway/arrivals?stop=${encodeURIComponent(body.results[0].id)}`, auth));
    expect(arr.status).toBe(200);
  });

  it("matches other names in a complex", async () => {
    const { body } = await search("port authority");
    expect(body.results[0].id).toBe(TIMES_SQ);
  });

  it("hides diamond express variants next to their base route", async () => {
    const { body } = await search("grand central");
    const ids = body.results[0].routes.map((r: { id: string }) => r.id);
    expect(ids).toContain("7");
    expect(ids).not.toContain("7X");
  });

  it("respects limit and returns empty results for no match", async () => {
    expect((await search("st", "&limit=3")).body.results).toHaveLength(3);
    expect((await search("zzzz")).body.results).toEqual([]);
  });

  it("requires q", async () => {
    const res = await searchHandler()(get("/stops/search?q=%20", auth));
    expect(res.status).toBe(400);
  });
});
