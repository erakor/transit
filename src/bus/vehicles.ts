import type { RouteDisplay } from '#src/schema.js'
import type { BusVehicle } from './schemas.js'
import type { VehicleMonitoring } from './siri.js'

/**
 * A compass heading (degrees clockwise from north) from Bus Time's bearing, which counts
 * counterclockwise from east.
 */
export function compassHeading(bearing: number): number {
  return Math.round((((90 - bearing) % 360) + 360) % 360)
}

/** One route's buses, by destination and then bus number. Pure. */
export function computeBusVehicles(answer: VehicleMonitoring): BusVehicle[] {
  return answer.vehicles
    .map(v => ({
      id: v.vehicle,
      headsign: v.destination,
      lat: v.lat,
      lon: v.lon,
      heading: v.bearing === undefined ? null : compassHeading(v.bearing),
      stop: v.stopId && v.stopName ? { id: v.stopId, name: v.stopName } : null,
      distance: v.distanceText,
      stopsAway: v.stopsAway ?? null,
      atTerminal: v.notYetDeparted,
      time: v.recordedAt ?? null,
      tripId: v.tripId,
    }))
    .sort((a, b) => a.headsign.localeCompare(b.headsign) || a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** A route id as riders may type it: any case, and `M15-SBS` for the Select Bus Service route `M15+`. */
export function findBusRoute(routes: Record<string, RouteDisplay>, raw: string): RouteDisplay | undefined {
  const id = raw.trim().toUpperCase().replace(/-SBS$/, '+')
  return routes[id]
}
