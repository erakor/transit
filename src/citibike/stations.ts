import type { GbfsFeed, GbfsStationInformation, GbfsStationStatus } from "./feeds.js";

export interface BikeStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Docks at the station, in any state. */
  capacity: number;
  /** Classic (pedal) bikes ready to rent. */
  bikes: number;
  /** E-bikes ready to rent. */
  ebikes: number;
  /** Free docks. */
  docks: number;
  /** False when the station isn't renting bikes (or isn't on the street at all). */
  renting: boolean;
  /** False when the station isn't accepting returns. */
  returning: boolean;
  /** When the station last reported, epoch seconds. Absent if it never did. */
  reportedAt?: number;
}

export interface BikeStations {
  /** `station_status`'s timestamp, epoch seconds. */
  updatedAt: number;
  /** Stations on the street, by lowercased id. */
  byId: Map<string, BikeStation>;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
/** GBFS 2.x booleans are 0/1 in Citi Bike's feed and true/false in the spec. */
const flag = (v: unknown): boolean => v === 1 || v === true;

/**
 * Joins the two GBFS station feeds. Stations that aren't installed (planned, or removed for the
 * season) and stations missing from either feed are left out: they have nothing to rent or return.
 */
export function joinStations(information: GbfsFeed<GbfsStationInformation>, status: GbfsFeed<GbfsStationStatus>): BikeStations {
  const statusById = new Map(status.data.stations.map((s) => [s.station_id, s]));
  const byId = new Map<string, BikeStation>();
  for (const info of information.data.stations) {
    const st = statusById.get(info.station_id);
    if (!st || !flag(st.is_installed)) continue;
    if (typeof info.lat !== "number" || typeof info.lon !== "number") continue;
    // num_bikes_available counts e-bikes too. (vehicle_types_available doesn't always add up
    // to it, so the split comes from num_ebikes_available.)
    const total = count(st.num_bikes_available);
    const ebikes = Math.min(count(st.num_ebikes_available), total);
    const station: BikeStation = {
      id: info.station_id,
      name: info.name,
      lat: info.lat,
      lon: info.lon,
      capacity: count(info.capacity),
      bikes: total - ebikes,
      ebikes,
      docks: count(st.num_docks_available),
      renting: flag(st.is_renting),
      returning: flag(st.is_returning),
    };
    // Stations that never reported carry a placeholder near zero.
    if (count(st.last_reported) > 1_000_000_000) station.reportedAt = count(st.last_reported);
    byId.set(station.id.toLowerCase(), station);
  }
  return { updatedAt: status.last_updated, byId };
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export type NearbyStation = BikeStation & { /** Meters from the requested point, as the crow flies. */ distance: number };

/** The `n` stations closest to a point, nearest first (ties by id, so the order is stable). */
export function nearestStations(stations: Iterable<BikeStation>, lat: number, lon: number, n: number): NearbyStation[] {
  const all: [number, BikeStation][] = [];
  for (const s of stations) all.push([Math.round(distanceMeters(lat, lon, s.lat, s.lon)), s]);
  all.sort(([da, a], [db, b]) => da - db || (a.id < b.id ? -1 : 1));
  return all.slice(0, n).map(([distance, s]) => ({ ...s, distance }));
}
