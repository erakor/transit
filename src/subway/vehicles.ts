import type { RouteInfo } from "../static/types.js";
import type { StationIndex } from "../stops/stations.js";
import { VEHICLE_STATUS } from "../agency/vehicles.js";
import { num, terminalName } from "./arrivals.js";
import type { FeedMessage } from "./feeds.js";

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

/** Trains that last reported longer ago than this are left out. */
export const TRAIN_MAX_AGE_S = 900;

/**
 * Where a route's trains are: the stop each one is at or heading to. The subway feeds carry no
 * coordinates, only stops. Pure: takes the decoded feed for the route and `now` (epoch seconds).
 * Trains go northbound first, each direction in stop id order, which follows the line.
 */
export function computeSubwayTrains(route: RouteInfo, feed: FeedMessage, index: StationIndex, { now }: { now: number }): SubwayTrainsResult {
  const headsigns = new Map<string, string>();
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (tu?.trip?.tripId) headsigns.set(tu.trip.tripId, terminalName(tu.stopTimeUpdate ?? [], index));
  }
  const trains: SubwayTrain[] = [];
  for (const entity of feed.entity) {
    const v = entity.vehicle;
    if (!v || entity.isDeleted || v.trip?.routeId !== route.id) continue;
    const time = num(v.timestamp) ?? null;
    if (time !== null && time < now - TRAIN_MAX_AGE_S) continue;
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
