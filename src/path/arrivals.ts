import type { PathFeed } from './feed.js'
import { routeForColors, routeOrder, type PathStation } from './stations.js'

export interface PathArrival {
  /** Epoch seconds. */
  time: number
  headsign: string
}

export interface PathRouteDirectionArrivals {
  route: string
  name: string
  color: string
  textColor: string
  /** "NY" (toward Manhattan) or "NJ", as the feed labels the train at this station. */
  direction: 'NY' | 'NJ'
  /** Headsign of the next train. */
  headsign: string
  arrivals: PathArrival[]
}

export interface PathArrivalsResult {
  station: { id: string; name: string }
  /** Oldest update time among this station's trains in the feed (epoch seconds). */
  updatedAt: number | null
  groups: PathRouteDirectionArrivals[]
}

/**
 * How long a train stays listed after its time. The feed refreshes about once a minute and shows
 * a train standing at the platform as 0 s away, so a train whose time has just passed is most
 * likely boarding. Longer than that, the feed has stopped updating and the train is gone.
 */
export const BOARDING_GRACE_S = 120

/**
 * Next trains per route and direction at `station`, from an already parsed feed. Pure: takes
 * `now` (epoch seconds). Each group keeps `limit` trains.
 */
export function computePathArrivals(
  station: PathStation,
  feed: PathFeed,
  { now, limit }: { now: number; limit: number }
): PathArrivalsResult {
  const trains = feed.stations[station.id] ?? []
  const groups = new Map<string, PathRouteDirectionArrivals>()
  for (const t of trains) {
    if (t.time < now - BOARDING_GRACE_S) continue
    // A line color PATH hasn't used before still shows up, under the feed's own color.
    const route = routeForColors(t.colors) ?? {
      id: t.colors || 'PATH',
      name: 'PATH',
      color: /^[0-9A-F]{6}/.test(t.colors) ? `#${t.colors.slice(0, 6)}` : '#808183',
      textColor: '#FFFFFF',
    }
    const key = `${route.id}|${t.direction}`
    let g = groups.get(key)
    if (!g) {
      g = {
        route: route.id,
        name: route.name,
        color: route.color,
        textColor: route.textColor,
        direction: t.direction,
        headsign: '',
        arrivals: [],
      }
      groups.set(key, g)
    }
    g.arrivals.push({ time: t.time, headsign: t.headsign })
  }

  const result = [...groups.values()]
    .map(g => {
      const arrivals = g.arrivals.sort((a, b) => a.time - b.time).slice(0, limit)
      return { ...g, headsign: arrivals[0]?.headsign ?? '', arrivals }
    })
    // PATH's route order, then toward New York ("NY") before New Jersey ("NJ").
    .sort(
      (a, b) =>
        routeOrder(a.route) - routeOrder(b.route) ||
        a.route.localeCompare(b.route) ||
        b.direction.localeCompare(a.direction)
    )

  return {
    station: { id: station.id, name: station.name },
    updatedAt: trains.length ? Math.min(...trains.map(t => t.updatedAt)) : null,
    groups: result,
  }
}
