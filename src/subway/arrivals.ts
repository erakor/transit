import type { RouteInfo, SubwayData } from '#src/static/types.js'
import type { ResolvedStop, StationIndex } from '#src/stops/stations.js'
import { num, oldestTimestamp, terminalName, type FeedMessage } from '#src/gtfsrt.js'

// Type-only: this pure module, the preview and the smoke test don't load zod.
import type { ArrivalsResult, RouteDirectionArrivals } from './schemas.js'

const FALLBACK_ROUTE = (id: string): RouteInfo => ({
  id,
  shortName: id,
  longName: '',
  color: '#808183',
  textColor: '#FFFFFF',
  sortOrder: 999,
})

/**
 * Next trains per route and direction at `stop`, from already decoded feeds.
 * Trains whose time has passed are dropped; each group keeps `limit` trains.
 */
export function computeArrivals(
  stop: ResolvedStop,
  feeds: FeedMessage[],
  index: StationIndex,
  { now, limit }: { now: number; limit: number }
): ArrivalsResult {
  const data: SubwayData = index.data
  const platforms = new Set(stop.platforms)
  const groups = new Map<string, RouteDirectionArrivals>()
  const seen = new Set<string>()

  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate
      if (!tu || entity.isDeleted) continue
      const routeId = tu.trip?.routeId ?? ''
      const tripId = tu.trip?.tripId ?? entity.id
      const updates = tu.stopTimeUpdate ?? []
      const headsign = terminalName(updates, id => index.stopName(id))
      for (const stu of updates) {
        const stopId = stu.stopId ?? ''
        if (!platforms.has(stopId)) continue
        if (stu.scheduleRelationship === 1 /* SKIPPED */) continue
        const time = num(stu.arrival?.time) ?? num(stu.departure?.time)
        if (time === undefined || time < now) continue
        const direction = stopId.endsWith('N') ? 'N' : 'S'
        const dedupe = `${tripId}|${stopId}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        const key = `${routeId}|${direction}`
        let g = groups.get(key)
        if (!g) {
          const r = data.routes[routeId] ?? FALLBACK_ROUTE(routeId)
          g = {
            route: routeId,
            name: r.shortName,
            color: r.color,
            textColor: r.textColor,
            direction,
            headsign: '',
            arrivals: [],
          }
          groups.set(key, g)
        }
        g.arrivals.push({ time, headsign, tripId })
      }
    }
  }

  const order = (r: string) => data.routes[r]?.sortOrder ?? 999
  const result = [...groups.values()]
    .map(g => {
      const arrivals = g.arrivals.sort((a, b) => a.time - b.time).slice(0, limit)
      return { ...g, headsign: arrivals[0]?.headsign ?? '', arrivals }
    })
    .sort(
      (a, b) =>
        order(a.route) - order(b.route) || a.route.localeCompare(b.route) || a.direction.localeCompare(b.direction)
    )

  return {
    stop: { id: stop.id, name: stop.name, stops: stop.stops },
    updatedAt: oldestTimestamp(feeds),
    groups: result,
  }
}
