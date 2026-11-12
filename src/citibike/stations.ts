import type { GbfsFeed, GbfsStationInformation, GbfsStationStatus } from './feeds.js'
import type { BikeStation, NearbyStation } from './schemas.js'

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

const EARTH_RADIUS_M = 6_371_000
const rad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

/** The `n` stations closest to a point, nearest first (ties by id, so the order is stable). */
export function nearestStations(stations: Iterable<BikeStation>, lat: number, lon: number, n: number): NearbyStation[] {
  if (n < 1) return []
  // Keeps the best n seen so far, sorted, instead of sorting every station.
  const best: [number, BikeStation][] = []
  const before = (d: number, s: BikeStation, [bd, b]: [number, BikeStation]) => d < bd || (d === bd && s.id < b.id)
  for (const s of stations) {
    const d = Math.round(distanceMeters(lat, lon, s.lat, s.lon))
    if (best.length === n && !before(d, s, best[n - 1]!)) continue
    let i = best.length
    while (i > 0 && before(d, s, best[i - 1]!)) i--
    best.splice(i, 0, [d, s])
    if (best.length > n) best.pop()
  }
  return best.map(([distance, s]) => ({ ...s, distance }))
}
