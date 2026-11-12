import type { RouteDisplay } from '#src/schema.js'

/**
 * Compact static data for MTA buses: route display fields only. Arrivals come from Bus Time,
 * which names the stop and the trip's destination itself, so no stops or trips are kept.
 */
export interface BusData {
  /** The feeds' feed_version values, distinct and sorted, joined with `+`. */
  feedVersion: string
  /** By GTFS route id (`M15+`, `BX12`, `Q06`), which Bus Time's line refs and the alerts feed use. */
  routes: Record<string, RouteDisplay>
}
