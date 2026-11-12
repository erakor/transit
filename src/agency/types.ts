import type { RouteDisplay } from '#src/gtfsrt.js'

/** Compact static data for an agency served by the generic handlers (LIRR, Metro-North, NYC Ferry). */

export type AgencyRoute = RouteDisplay

export interface AgencyStop {
  id: string
  name: string
  lat: number
  lon: number
  /** Routes with scheduled service here, by name. */
  routes: string[]
}

/**
 * A scheduled trip, kept only for agencies whose realtime feed says too little on its own
 * (NYC Ferry gives a trip id and its next stop, nothing else).
 */
export interface AgencyTrip {
  route: string
  /** Name of the trip's last stop. */
  headsign: string
  /** Stops in order, with the scheduled seconds since the trip's first stop. */
  stops: [stopId: string, offset: number][]
}

export interface AgencyData {
  /** feed_version from feed_info.txt, "" when the agency publishes none. */
  feedVersion: string
  routes: Record<string, AgencyRoute>
  stops: Record<string, AgencyStop>
  trips?: Record<string, AgencyTrip>
}
