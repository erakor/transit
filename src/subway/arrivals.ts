import type { RouteInfo, SubwayData } from "../static/types.js";
import type { ResolvedStop, StationIndex } from "../stops/stations.js";
import type { FeedMessage } from "./feeds.js";

export interface Arrival {
  /** Epoch seconds. */
  time: number;
  /** Name of the trip's last passenger stop in the feed. */
  headsign: string;
  tripId: string;
}

export interface RouteDirectionArrivals {
  route: string;
  /** Rider-facing route name ("S" for shuttles). */
  name: string;
  color: string;
  textColor: string;
  /** "N" or "S": the MTA's northbound/southbound platform. */
  direction: "N" | "S";
  /** Headsign of the next train. */
  headsign: string;
  arrivals: Arrival[];
}

export interface ArrivalsResult {
  stop: { id: string; name: string; stops: string[] };
  /** Oldest header timestamp among the feeds used (epoch seconds). */
  updatedAt: number | null;
  groups: RouteDirectionArrivals[];
}

type Long = { toNumber(): number };
function num(v: number | Long | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : v.toNumber();
  return n > 0 ? n : undefined;
}

const FALLBACK_ROUTE = (id: string): RouteInfo => ({
  id,
  shortName: id,
  longName: "",
  color: "#808183",
  textColor: "#FFFFFF",
  sortOrder: 999,
});

/**
 * Next trains per route and direction at `stop`, from already decoded feeds.
 * Trains that left more than `graceSeconds` ago are dropped; each group keeps `limit` trains.
 */
export function computeArrivals(
  stop: ResolvedStop,
  feeds: FeedMessage[],
  index: StationIndex,
  { now, limit, graceSeconds = 0 }: { now: number; limit: number; graceSeconds?: number },
): ArrivalsResult {
  const data: SubwayData = index.data;
  const platforms = new Set(stop.platforms);
  const groups = new Map<string, RouteDirectionArrivals>();
  const seen = new Set<string>();

  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu || entity.isDeleted) continue;
      const routeId = tu.trip?.routeId ?? "";
      const tripId = tu.trip?.tripId ?? entity.id;
      const updates = tu.stopTimeUpdate ?? [];
      const headsign = terminalName(updates, index);
      for (const stu of updates) {
        const stopId = stu.stopId ?? "";
        if (!platforms.has(stopId)) continue;
        if (stu.scheduleRelationship === 1 /* SKIPPED */) continue;
        const time = num(stu.arrival?.time) ?? num(stu.departure?.time);
        if (time === undefined || time < now - graceSeconds) continue;
        const direction = stopId.endsWith("N") ? "N" : "S";
        const dedupe = `${tripId}|${stopId}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const key = `${routeId}|${direction}`;
        let g = groups.get(key);
        if (!g) {
          const r = data.routes[routeId] ?? FALLBACK_ROUTE(routeId);
          g = { route: routeId, name: r.shortName, color: r.color, textColor: r.textColor, direction, headsign: "", arrivals: [] };
          groups.set(key, g);
        }
        g.arrivals.push({ time, headsign, tripId });
      }
    }
  }

  const order = (r: string) => data.routes[r]?.sortOrder ?? 999;
  const result = [...groups.values()]
    .map((g) => {
      const arrivals = g.arrivals.sort((a, b) => a.time - b.time).slice(0, limit);
      return { ...g, headsign: arrivals[0]?.headsign ?? "", arrivals };
    })
    .sort((a, b) => order(a.route) - order(b.route) || a.route.localeCompare(b.route) || a.direction.localeCompare(b.direction));

  const stamps = feeds.map((f) => num(f.header?.timestamp)).filter((t): t is number => t !== undefined);
  return {
    stop: { id: stop.id, name: stop.name, stops: stop.stops },
    updatedAt: stamps.length ? Math.min(...stamps) : null,
    groups: result,
  };
}

/**
 * The trip's last stop with a known name. Feeds sometimes end a trip at a yard or
 * non-revenue track id that isn't in the static stops, so walk back to the last real one.
 */
function terminalName(updates: { stopId?: string | null }[], index: StationIndex): string {
  for (let i = updates.length - 1; i >= 0; i--) {
    const name = index.stopName(updates[i]!.stopId ?? "");
    if (name) return name;
  }
  return "";
}
