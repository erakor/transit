import { fallbackRoute } from '#src/gtfsrt.js'
import { rankByName, tokenize, type NameEntry } from '#src/stops/search.js'
import type { AgencyData, AgencyRoute, AgencyStop, StopParam } from './types.js'

/**
 * An agency served by the generic handlers in src/routes/agency.ts: a static GTFS
 * (src/data/<id>.generated.ts) and GTFS-realtime feeds that use its stop ids.
 */
export interface Agency {
  id: string
  name: string
  stopParam: StopParam
  /** The error code for an unknown stop: `unknown_station` where the agency says station, else `unknown_stop`. */
  unknownCode: 'unknown_station' | 'unknown_stop'
  /** What runs here, for the preview's "no trains soon". */
  vehicleWord: string
  /** Feed names or URLs, see `feedUrl`. */
  tripsFeed: string
  /** Where vehicle positions are, when not in `tripsFeed`. */
  vehiclesFeed?: string
  alertsFeed: string
  /**
   * The static data, imported on first use so a request loads one agency's: the three are large, and a function
   * instance usually serves one of them. The module system caches the import, so every call gives the same object
   * (`searchStops` caches on it).
   */
  data: () => Promise<AgencyData>
  /** Whether `data` carries a schedule (`trips`), which the docs mention; a test checks it against the data. */
  scheduled: boolean
}

const FERRY = 'https://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/'

export const AGENCIES: Record<string, Agency> = {
  lirr: {
    id: 'lirr',
    name: 'LIRR',
    stopParam: 'station',
    unknownCode: 'unknown_station',
    vehicleWord: 'trains',
    tripsFeed: 'lirr/gtfs-lirr',
    alertsFeed: 'camsys/lirr-alerts',
    scheduled: false,
    data: () => import('#src/data/lirr.generated.js').then((m) => m.LIRR_DATA),
  },
  mnr: {
    id: 'mnr',
    name: 'Metro-North',
    stopParam: 'station',
    unknownCode: 'unknown_station',
    vehicleWord: 'trains',
    tripsFeed: 'mnr/gtfs-mnr',
    alertsFeed: 'camsys/mnr-alerts',
    scheduled: false,
    data: () => import('#src/data/mnr.generated.js').then((m) => m.MNR_DATA),
  },
  ferry: {
    id: 'ferry',
    name: 'NYC Ferry',
    stopParam: 'stop',
    unknownCode: 'unknown_stop',
    vehicleWord: 'ferries',
    tripsFeed: FERRY + 'tripupdate',
    vehiclesFeed: FERRY + 'vehicleposition',
    alertsFeed: FERRY + 'alert',
    scheduled: true,
    data: () => import('#src/data/ferry.generated.js').then((m) => m.FERRY_DATA),
  },
}

/** A route's display fields; a route id the static data doesn't know shows under its id. */
export function routeInfo(data: AgencyData, id: string): AgencyRoute {
  return data.routes[id] ?? fallbackRoute(id)
}

/** A stop by id, case insensitive. */
export function findStop(data: AgencyData, raw: string): AgencyStop | undefined {
  const id = raw.trim()
  return data.stops[id] ?? data.stops[id.toUpperCase()] ?? data.stops[id.toLowerCase()]
}

const searchEntries = new Map<AgencyData, NameEntry<AgencyStop>[]>()

/** Stops matching a name, best first (see `rankByName`); ties go to busier stops, then by name. */
export function searchStops(data: AgencyData, query: string): AgencyStop[] {
  let entries = searchEntries.get(data)
  if (!entries) {
    entries = Object.values(data.stops).map((stop) => ({
      item: stop,
      names: [tokenize(stop.name)],
    }))
    searchEntries.set(data, entries)
  }
  return rankByName(
    entries,
    query,
    (a, b) => b.routes.length - a.routes.length || a.name.localeCompare(b.name),
  )
}
