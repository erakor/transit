import type { RouteInfo } from "#src/static/types.js";
import type { StationIndex } from "#src/stops/stations.js";
import { num, terminalName, VEHICLE_MAX_AGE_S, VEHICLE_STATUS, type FeedMessage } from "#src/gtfsrt.js";

export interface SubwayTrain {
  tripId: string;
  /** "N" or "S", from the platform the train is at or heading to. */
  direction: "N" | "S" | null;
  /** Name of the trip's last passenger stop in the feed. */
  headsign: string;
  /** Relative to `stop`. */
  status: (typeof VEHICLE_STATUS)[number];
  stop: { id: string; name: string } | null;
  /** When the train last reported (epoch seconds). */
  time: number | null;
}

export interface SubwayTrainsResult {
  route: { id: string; name: string; color: string; textColor: string };
  /** Header timestamp of the feed (epoch seconds). */
  updatedAt: number | null;
  vehicles: SubwayTrain[];
}

/**
 * Where a route's trains are: the stop each one is at or heading to. The subway feeds carry no
 * coordinates, only stops. Pure: takes the decoded feed for the route and `now` (epoch seconds).
 * Trains that last reported over `VEHICLE_MAX_AGE_S` ago are left out.
 * Trains go northbound first, each direction in stop id order, which follows the line.
 */
export function computeSubwayTrains(route: RouteInfo, feed: FeedMessage, index: StationIndex, { now }: { now: number }): SubwayTrainsResult {
  const headsigns = new Map<string, string>();
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (tu?.trip?.tripId) headsigns.set(tu.trip.tripId, terminalName(tu.stopTimeUpdate ?? [], (id) => index.stopName(id)));
  }
  const trains: SubwayTrain[] = [];
  for (const entity of feed.entity) {
    const v = entity.vehicle;
    if (!v || entity.isDeleted || v.trip?.routeId !== route.id) continue;
    const time = num(v.timestamp) ?? null;
    if (time !== null && time < now - VEHICLE_MAX_AGE_S) continue;
    const stopId = v.stopId ?? "";
    const name = index.stopName(stopId);
    const tripId = v.trip.tripId ?? entity.id;
    trains.push({
      tripId,
      direction: /[NS]$/.test(stopId) ? (stopId.slice(-1) as "N" | "S") : null,
      headsign: headsigns.get(tripId) ?? "",
      // Absent means the protobuf default, IN_TRANSIT_TO.
      status: VEHICLE_STATUS[v.currentStatus as number] ?? "IN_TRANSIT_TO",
      stop: name ? { id: stopId, name } : null,
      time,
    });
  }
  trains.sort(
    (a, b) => (a.direction ?? "Z").localeCompare(b.direction ?? "Z") || (a.stop?.id ?? "").localeCompare(b.stop?.id ?? "") || a.tripId.localeCompare(b.tripId),
  );
  return {
    route: { id: route.id, name: route.shortName, color: route.color, textColor: route.textColor },
    updatedAt: num(feed.header?.timestamp) ?? null,
    vehicles: trains,
  };
}
