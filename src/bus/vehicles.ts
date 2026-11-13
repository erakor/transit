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
