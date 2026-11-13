import type { GbfsFeed, GbfsStationInformation, GbfsStationStatus } from './feeds.js'
import type { BikeStation, NearbyStation } from './schemas.js'
import { nearest } from '#src/geo.js'

export interface BikeStations {
  /** `station_status`'s timestamp, epoch seconds. */
  updatedAt: number
  /** Stations on the street, by id (exact: ids are opaque). */
  byId: Map<string, BikeStation>
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
/** GBFS 2.x booleans are 0/1 in Citi Bike's feed and true/false in the spec; anything else is `unknown`. */
const flag = (v: unknown, unknown: boolean): boolean =>
  v === 1 || v === true ? true : v === 0 || v === false ? false : unknown

/**
 * Joins the two GBFS station feeds. Stations that aren't installed (planned, or removed for the
 * season) and stations missing from either feed are left out: they have nothing to rent or return.
 */
export function joinStations(
  information: GbfsFeed<GbfsStationInformation>,
  status: GbfsFeed<GbfsStationStatus>
): BikeStations {
  const statusById = new Map(status.data.stations.map(s => [s.station_id, s]))
  const byId = new Map<string, BikeStation>()
  for (const info of information.data.stations) {
    const st = statusById.get(info.station_id)
    // A status without the flag is taken as installed: dropping every station would be worse.
    if (!st || !flag(st.is_installed, true)) continue
    if (typeof info.name !== 'string' || typeof info.lat !== 'number' || typeof info.lon !== 'number') continue
    // num_bikes_available counts e-bikes too. (vehicle_types_available doesn't always add up
    // to it, so the split comes from num_ebikes_available.)
    const total = count(st.num_bikes_available)
    const ebikes = Math.min(count(st.num_ebikes_available), total)
    const station: BikeStation = {
      id: info.station_id,
      name: info.name,
      lat: info.lat,
      lon: info.lon,
      capacity: count(info.capacity),
      bikes: total - ebikes,
      ebikes,
      docks: count(st.num_docks_available),
      renting: flag(st.is_renting, false),
      returning: flag(st.is_returning, false),
    }
    // Stations that never reported carry a placeholder near zero.
    if (count(st.last_reported) > 1_000_000_000) station.reportedAt = count(st.last_reported)
    byId.set(station.id, station)
  }
  return { updatedAt: status.last_updated, byId }
}

/** The `n` stations closest to a point, nearest first (ties by id, so the order is stable). */
export function nearestStations(stations: Iterable<BikeStation>, lat: number, lon: number, n: number): NearbyStation[] {
  return nearest(stations, lat, lon, n, s => s.id).map(([distance, s]) => ({ ...s, distance }))
}
