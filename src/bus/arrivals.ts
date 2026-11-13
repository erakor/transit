import { fallbackRoute } from '#src/gtfsrt.js'
import type { RouteDisplay } from '#src/schema.js'
import type { BusArrival, BusArrivalsResponse } from './schemas.js'
import type { StopMonitoring } from './siri.js'

/**
 * A route's display fields by GTFS route id; one the static data lacks shows under the name the
 * bus displays, in gray.
 */
export function busRoute(routes: Record<string, RouteDisplay>, id: string, shownAs = ''): RouteDisplay {
  return routes[id] ?? routes[id.toUpperCase()] ?? { ...fallbackRoute(id), name: shownAs || id }
}

/**
 * A route id as riders may type it: any case, and `M15-SBS` for the Select Bus Service route
 * `M15+`. Takes the parameter as the URL decodes it, before trimming: an unencoded `+` decodes
 * as a space, and still means the Select Bus Service route rather than the local one.
 */
export function busRouteId(raw: string): string {
  return raw
    .replace(/^\s+/, '')
    .replace(/(?<=\S) $/, '+')
    .trim()
    .toUpperCase()
    .replace(/-SBS$/, '+')
}

/**
 * The buses on their way to `stop`, in one list: predicted ones soonest first, then those Bus Time
 * can't time yet (at their terminal), nearest first. Cancelled trips are listed at their scheduled
 * time, marked. Pure.
 */
export function computeBusArrivals(
  stop: string,
  answer: StopMonitoring,
  routes: Record<string, RouteDisplay>,
  { limit }: { limit: number }
): BusArrivalsResponse {
  const arrivals: BusArrival[] = answer.visits.map(v => {
    const route = busRoute(routes, v.routeId, v.publishedName)
    return {
      time: v.time ?? null,
      route: route.id,
      name: route.name,
      color: route.color,
      textColor: route.textColor,
      headsign: v.destination,
      distance: v.distanceText,
      stopsAway: v.stopsAway ?? null,
      meters: v.meters ?? null,
      atTerminal: v.notYetDeparted,
      cancelled: v.cancelled,
      vehicle: v.vehicle,
      tripId: v.tripId,
    }
  })
  const far = Number.MAX_SAFE_INTEGER
  arrivals.sort(
    (a, b) =>
      (a.time ?? far) - (b.time ?? far) ||
      (a.meters ?? far) - (b.meters ?? far) ||
      a.name.localeCompare(b.name) ||
      a.tripId.localeCompare(b.tripId)
  )
  const name = answer.visits.find(v => v.stopName)?.stopName ?? null
  // Cancelled trips stay where they fall, but only buses that will come count toward `limit`.
  const kept: BusArrival[] = []
  let coming = 0
  for (const a of arrivals) {
    if (coming === limit) break
    kept.push(a)
    if (!a.cancelled) coming++
  }
  return { stop: { id: stop, name }, updatedAt: answer.updatedAt, arrivals: kept }
}
