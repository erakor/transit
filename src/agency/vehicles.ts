import { num, oldestTimestamp, terminalName, VEHICLE_MAX_AGE_S, VEHICLE_STATUS, type FeedMessage } from '#src/gtfsrt.js'
import { routeInfo } from './agencies.js'
import type { AgencyVehicle, AgencyVehiclesResponse } from './schemas.js'
import type { AgencyData } from './types.js'

/**
 * Where the agency's vehicles are. `feeds` are the trip updates and, when separate, the vehicle
 * positions; a vehicle's route and headsign come from its trip's update or the static trips.
 * Positions older than `VEHICLE_MAX_AGE_S` are left out. Pure: takes `now` (epoch seconds).
 */
export function computeAgencyVehicles(
  feeds: FeedMessage[],
  data: AgencyData,
  { now, route: onlyRoute }: { now: number; route?: string }
): AgencyVehiclesResponse {
  const trips = new Map<string, { route: string; headsign: string }>()
  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate
      if (!tu) continue
      const info = {
        route: tu.trip?.routeId ?? '',
        headsign: terminalName(tu.stopTimeUpdate ?? [], id => data.stops[id]?.name),
      }
      // Metro-North's vehicles name their trip by the entity id, not the trip id.
      for (const key of [tu.trip?.tripId, entity.id]) if (key) trips.set(key, info)
    }
  }

  const vehicles: AgencyVehicle[] = []
  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const v = entity.vehicle
      const lat = v?.position?.latitude
      const lon = v?.position?.longitude
      if (!v || entity.isDeleted || typeof lat !== 'number' || typeof lon !== 'number' || (lat === 0 && lon === 0))
        continue
      const time = num(v.timestamp) ?? null
      if (time !== null && time < now - VEHICLE_MAX_AGE_S) continue
      const tripId = v.trip?.tripId ?? ''
      const scheduled = data.trips?.[tripId]
      const live = trips.get(tripId) ?? trips.get(entity.id)
      const routeId = v.trip?.routeId || live?.route || scheduled?.route || ''
      if (onlyRoute !== undefined && routeId !== onlyRoute) continue
      const stop = data.stops[v.stopId ?? '']
      vehicles.push({
        id: v.vehicle?.id || entity.id,
        label: v.vehicle?.label ?? '',
        tripId,
        route: routeId ? routeInfo(data, routeId) : null,
        headsign: scheduled?.headsign || live?.headsign || '',
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
        status: Object.hasOwn(v, 'currentStatus') ? (VEHICLE_STATUS[v.currentStatus as number] ?? null) : null,
        stop: stop ? { id: stop.id, name: stop.name } : null,
        time,
      })
    }
  }
  vehicles.sort((a, b) => (a.route?.name ?? '').localeCompare(b.route?.name ?? '') || a.id.localeCompare(b.id))
  return { updatedAt: oldestTimestamp(feeds), vehicles }
}
