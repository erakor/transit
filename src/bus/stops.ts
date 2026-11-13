/**
 * Bus stops near a point, from MTA Bus Time's OneBusAway "Discovery" API (`stops-for-location`),
 * which serves the static stop data (code, name, position, routes) so the bus function doesn't
 * bundle the 13,500 stops. Same key as SIRI, and the key is in the query string, so no error
 * carries the URL.
 */
import { distanceMeters } from '#src/geo.js'
import { memoized, type Fetcher } from '#src/gtfsrt.js'
import type { RouteDisplay } from '#src/schema.js'
import { busRoute } from './arrivals.js'
import type { NearbyBusStop } from './schemas.js'
import { stripOperator } from './siri.js'

const BASE = 'https://bustime-classic.mta.info/api/where/stops-for-location.json'

/** Stops change with the quarterly schedules: a lookup is kept 10 minutes. */
const STOPS_TTL_MS = 10 * 60_000

/** The request: a radius in meters around a point rounded to 4 decimals (about 10 m), so nearby asks share it. */
export function stopsForLocationUrl(lat: number, lon: number, radiusM: number, key: string): string {
  const query = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4), radius: String(radiusM), key })
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
    if (!/^\d{6}$/.test(code) || typeof s.lat !== 'number' || typeof s.lon !== 'number') continue
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
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {}
): Promise<BusStopInfo[]> {
  const url = stopsForLocationUrl(lat, lon, radiusM, key)
  return memoized(
    `bustime-stops:${lat.toFixed(4)},${lon.toFixed(4)},${radiusM}`,
    now,
    async () => {
      const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`bustime stops: HTTP ${res.status}`)
      return parseStopsForLocation(await res.json())
    },
    STOPS_TTL_MS
  )
}

/** The `limit` stops nearest the point, nearest first (ties by code), with route names and colors. Pure. */
export function nearestBusStops(
  stops: BusStopInfo[],
  lat: number,
  lon: number,
  routes: Record<string, RouteDisplay>,
  limit: number
): NearbyBusStop[] {
  return stops
    .map(s => ({ s, d: distanceMeters(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d || a.s.code.localeCompare(b.s.code))
    .slice(0, limit)
    .map(({ s, d }) => ({
      id: s.code,
      name: s.name,
      direction: s.direction,
      lat: s.lat,
      lon: s.lon,
      distance: Math.round(d),
      routes: s.routeIds
        .map(id => busRoute(routes, id))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    }))
}
