/**
 * Bus stops near a point, from MTA Bus Time's OneBusAway "Discovery" API (`stops-for-location`),
 * which serves the static stop data (code, name, position, routes) so the bus function doesn't
 * bundle the 13,500 stops. Same key as SIRI, and the key is in the query string, so no error
 * carries the URL.
 */
import { nearest } from '#src/geo.js'
import type { FetchOptions } from '#src/gtfsrt.js'
import type { RouteDisplay } from '#src/schema.js'
import { busRoute } from './arrivals.js'
import type { NearbyBusStop } from './schemas.js'
import { fetchBusTime, STOP_CODE, stripOperator } from './siri.js'

const BASE = 'https://bustime-classic.mta.info/api/where/stops-for-location.json'

/** Stops change with the quarterly schedules: a lookup is kept 10 minutes. */
const STOPS_TTL_MS = 10 * 60_000

/**
 * Points are rounded to 3 decimals (about 100 m), so nearby asks share a request and its memo;
 * the request's radius grows by `ROUNDING_MARGIN_M` to still cover the point's own radius.
 */
const rounded = (deg: number): string => deg.toFixed(3)
const ROUNDING_MARGIN_M = 100

/**
 * The most stops one answer holds. The API's default, 100, is reached within 800 m of Times Sq,
 * and past it the answer is an arbitrary subset (`limitExceeded`), not the nearest stops.
 */
const MAX_COUNT = 250

/** The request: the stops within `radiusM` of a point, around the rounded point. */
export function stopsForLocationUrl(lat: number, lon: number, radiusM: number, key: string): string {
  const query = new URLSearchParams({
    lat: rounded(lat),
    lon: rounded(lon),
    radius: String(radiusM + ROUNDING_MARGIN_M),
    maxCount: String(MAX_COUNT),
    key,
  })
  return `${BASE}?${query}`
}

/** A bus stop as the API describes it. */
export interface BusStopInfo {
  /** The six-digit code on the stop's sign, which `/bus/arrivals` takes. */
  code: string
  name: string
  /** Which way buses there head: `N`, `NE`, ..., empty when unknown. */
  direction: string
  lat: number
  lon: number
  /** GTFS route ids (`M15+`), without their operator. */
  routeIds: string[]
}

interface ObaBody {
  code?: number
  text?: string
  data?: {
    stops?: {
      code?: string
      id?: string
      name?: string
      direction?: string
      lat?: number
      lon?: number
      routes?: { id?: string }[]
    }[]
  }
}

/**
 * Reads a `stops-for-location` answer. Anything but `code: 200` with a stop list throws (a bad
 * key is answered `null`), so it is not memoized. A stop without a code or a position is
 * skipped. Pure.
 */
export function parseStopsForLocation(body: unknown): BusStopInfo[] {
  const b = body as ObaBody | null
  if (b?.code !== 200 || !Array.isArray(b.data?.stops))
    throw new Error(`bustime stops: not a stop list (code ${b?.code ?? 'none'})`)
  const stops: BusStopInfo[] = []
  for (const s of b.data.stops) {
    const code = (s.code || stripOperator(s.id)).trim()
    if (!STOP_CODE.test(code) || typeof s.lat !== 'number' || typeof s.lon !== 'number') continue
    stops.push({
      code,
      name: (s.name ?? '').trim(),
      direction: (s.direction ?? '').trim().toUpperCase(),
      lat: s.lat,
      lon: s.lon,
      routeIds: [...new Set((s.routes ?? []).map(r => stripOperator(r.id)).filter(Boolean))],
    })
  }
  return stops
}

/** The stops within `radiusM` of a point, through a 10 minute memo. */
export function fetchStopsForLocation(
  lat: number,
  lon: number,
  radiusM: number,
  key: string,
  options?: FetchOptions
): Promise<BusStopInfo[]> {
  const url = stopsForLocationUrl(lat, lon, radiusM, key)
  const memoKey = `bustime-stops:${rounded(lat)},${rounded(lon)},${radiusM}`
  return fetchBusTime(memoKey, url, 'stops', parseStopsForLocation, options, STOPS_TTL_MS)
}

/**
 * The `limit` stops nearest the point within `radiusM`, nearest first (ties by code), with route
 * names and colors. Pure.
 */
export function nearestBusStops(
  stops: BusStopInfo[],
  lat: number,
  lon: number,
  routes: Record<string, RouteDisplay>,
  limit: number,
  radiusM = Infinity
): NearbyBusStop[] {
  // The answer covers a rounded point, so it can hold stops just past the radius.
  const within = nearest(stops, lat, lon, limit, s => s.code).filter(([distance]) => distance <= radiusM)
  return within.map(([distance, s]) => ({
    id: s.code,
    name: s.name,
    direction: s.direction,
    lat: s.lat,
    lon: s.lon,
    distance,
    routes: s.routeIds
      .map(id => busRoute(routes, id))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
  }))
}
