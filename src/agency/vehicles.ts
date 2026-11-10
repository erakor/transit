import { num } from "../subway/arrivals.js";
import type { FeedMessage } from "../subway/feeds.js";
import { routeInfo } from "./agencies.js";
import { lastStopName } from "./arrivals.js";
import type { AgencyData, AgencyRoute } from "./types.js";

export const VEHICLE_STATUS = ["INCOMING_AT", "STOPPED_AT", "IN_TRANSIT_TO"] as const;

export interface AgencyVehicle {
  id: string;
  /** The number riders and crews know it by (train number, boat name), when the feed has one. */
  label: string;
  tripId: string;
  route: AgencyRoute | null;
  /** Where its trip ends, "" when unknown. */
  headsign: string;
  lat: number;
  lon: number;
  /** Relative to `stop`; null when the feed doesn't say. */
  status: (typeof VEHICLE_STATUS)[number] | null;
  stop: { id: string; name: string } | null;
  /** When the position was measured (epoch seconds). */
  time: number | null;
}

/** Positions older than this are left out: the feeds keep finished trips around for hours. */
export const VEHICLE_MAX_AGE_S = 900;

/**
 * Where the agency's vehicles are. `feeds` are the trip updates and, when separate, the vehicle
 * positions; a vehicle's route and headsign come from its trip's update or the static trips.
 * Pure: takes `now` (epoch seconds).
 */
export function computeAgencyVehicles(
  feeds: FeedMessage[],
  data: AgencyData,
  { now, route: onlyRoute }: { now: number; route?: string },
): { updatedAt: number | null; vehicles: AgencyVehicle[] } {
  const trips = new Map<string, { route: string; headsign: string }>();
  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      const info = { route: tu.trip?.routeId ?? "", headsign: lastStopName(tu.stopTimeUpdate ?? [], data) };
      // Metro-North's vehicles name their trip by the entity id, not the trip id.
      for (const key of [tu.trip?.tripId, entity.id]) if (key) trips.set(key, info);
    }
  }

  const vehicles: AgencyVehicle[] = [];
  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const v = entity.vehicle;
      const lat = v?.position?.latitude;
      const lon = v?.position?.longitude;
      if (!v || entity.isDeleted || typeof lat !== "number" || typeof lon !== "number" || (lat === 0 && lon === 0)) continue;
      const time = num(v.timestamp) ?? null;
      if (time !== null && time < now - VEHICLE_MAX_AGE_S) continue;
      const tripId = v.trip?.tripId ?? "";
      const scheduled = data.trips?.[tripId];
      const live = trips.get(tripId) ?? trips.get(entity.id);
      const routeId = v.trip?.routeId || live?.route || scheduled?.route || "";
      if (onlyRoute !== undefined && routeId !== onlyRoute) continue;
      const stop = data.stops[v.stopId ?? ""];
      vehicles.push({
        id: v.vehicle?.id || entity.id,
        label: v.vehicle?.label ?? "",
        tripId,
        route: routeId ? routeInfo(data, routeId) : null,
        headsign: scheduled?.headsign || live?.headsign || "",
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
        status: Object.hasOwn(v, "currentStatus") ? (VEHICLE_STATUS[v.currentStatus as number] ?? null) : null,
        stop: stop ? { id: stop.id, name: stop.name } : null,
        time,
      });
    }
  }
  vehicles.sort((a, b) => (a.route?.name ?? "").localeCompare(b.route?.name ?? "") || a.id.localeCompare(b.id));
  const stamps = feeds.map((f) => num(f.header?.timestamp)).filter((t): t is number => t !== undefined);
  return { updatedAt: stamps.length ? Math.min(...stamps) : null, vehicles };
}
