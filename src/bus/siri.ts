/**
 * MTA Bus Time's SIRI StopMonitoring API: the buses headed to one stop, with where each one is.
 * Plain JSON, one request per stop, with the API key in the query string (`key=`).
 *
 * The response nests everything under `Siri.ServiceDelivery`. Fields this service doesn't use are
 * left out of the types below. Distances come as SIRI 2 fields of `MonitoredCall`, or, in the
 * SIRI 1 shape the API answers without `version=2`, under `MonitoredCall.Extensions.Distances`;
 * the parser reads either.
 */
import { memoized, type Fetcher } from '#src/gtfsrt.js'

/** The `/api/2/` path also lists cancelled trips, marked as such; `/api/siri/` leaves them out. */
const BASE = 'https://bustime.mta.info/api/2/siri/stop-monitoring.json'
const VEHICLES = 'https://bustime.mta.info/api/siri/vehicle-monitoring.json'

/** A stop code as riders see it on the stop's sign, and as the API takes it after `MTA_`. */
export const STOP_CODE = /^\d{6}$/

/** The request for one stop: SIRI 2, every operator (MTA New York City Transit and MTA Bus). */
export function stopMonitoringUrl(stop: string, key: string): string {
  const query = new URLSearchParams({
    key,
    version: '2',
    OperatorRef: 'MTA',
    MonitoringRef: stop,
    // `minimum` leaves out the line, trip and stop name; `basic` is the smallest level with them.
    StopMonitoringDetailLevel: 'basic',
  })
  return `${BASE}?${query}`
}

/** The request for one route's buses: SIRI 2, with each bus's next stop and destination. */
export function vehicleMonitoringUrl(route: string, key: string): string {
  const query = new URLSearchParams({ key, version: '2', LineRef: route, VehicleMonitoringDetailLevel: 'normal' })
  return `${VEHICLES}?${query}`
}

interface SiriCall {
  AimedArrivalTime?: string
  ExpectedArrivalTime?: string
  ArrivalStatus?: string
  DepartureStatus?: string
  ExpectedDepartureTime?: string
  ArrivalProximityText?: string
  DistanceFromStop?: number
  NumberOfStopsAway?: number
  StopPointRef?: string
  StopPointName?: string | string[]
  Extensions?: { Distances?: { PresentableDistance?: string; DistanceFromCall?: number; StopsFromCall?: number } }
}

interface SiriJourney {
  LineRef?: string
  PublishedLineName?: string | string[]
  DestinationName?: string | string[]
  FramedVehicleJourneyRef?: { DatedVehicleJourneyRef?: string }
  VehicleRef?: string
  ProgressStatus?: string | string[]
  /** SIRI 2: `cancelled` for a cancelled trip. */
  VehicleStatus?: string
  VehicleLocation?: { Latitude?: number; Longitude?: number }
  Bearing?: number
  MonitoredCall?: SiriCall
}

interface SiriDelivery {
  MonitoredStopVisit?: { MonitoredVehicleJourney?: SiriJourney }[]
  ErrorCondition?: { Description?: string; OtherError?: { ErrorText?: string } }
}

interface SiriVehicleDelivery {
  VehicleActivity?: { MonitoredVehicleJourney?: SiriJourney; RecordedAtTime?: string }[]
  ErrorCondition?: SiriDelivery['ErrorCondition']
}

interface SiriBody {
  Siri?: {
    ServiceDelivery?: {
      ResponseTimestamp?: string
      StopMonitoringDelivery?: SiriDelivery[]
      VehicleMonitoringDelivery?: SiriVehicleDelivery[]
    }
  }
}

/** A bus on its way to the stop, as the API describes it. */
export interface BusVisit {
  /** GTFS route id: the line ref without its operator prefix (`MTA NYCT_M15+` -> `M15+`). */
  routeId: string
  /** What the bus shows (`M15-SBS`); empty when the API leaves it out. */
  publishedName: string
  destination: string
  tripId: string
  /** The bus number, without its operator prefix; empty when unknown. */
  vehicle: string
  /** Predicted arrival, epoch seconds; undefined when Bus Time has no prediction (a bus at its terminal). */
  time?: number
  /** "approaching", "2 stops away", "1.3 miles away". */
  distanceText: string
  stopsAway?: number
  /** Meters along the route. */
  meters?: number
  /** At the start of its trip (`layover`) or still finishing the one before (`prevTrip`). */
  notYetDeparted: boolean
  /** The trip is cancelled: Bus Time lists it at its scheduled time so riders know it won't come. */
  cancelled: boolean
  stopName: string
}

export interface StopMonitoring {
  /** The response timestamp, epoch seconds. */
  updatedAt: number | null
  /** Set when the API answered an error instead of visits (`No such stop: MTA_999999.`). */
  error?: string
  visits: BusVisit[]
}

/** SIRI values that can be a string or a list of strings (names, statuses). */
function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
}

/** "MTA NYCT_M15+" -> "M15+", "MTA_308209" -> "308209". */
export function stripOperator(ref: string | undefined): string {
  return (ref ?? '').replace(/^[^_]*_/, '')
}

/** An ISO 8601 time with offset, as epoch seconds; undefined when absent or unreadable. */
function epoch(iso: string | undefined): number | undefined {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

function count(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
}

/**
 * Reads a StopMonitoring answer. A body that isn't SIRI throws (so it is not memoized); an
 * `ErrorCondition` is returned as `error`. A visit without a line ref is skipped rather than
 * failing the stop. Pure.
 */
export function parseStopMonitoring(body: unknown): StopMonitoring {
  const delivery = (body as SiriBody | null)?.Siri?.ServiceDelivery
  if (!delivery || !Array.isArray(delivery.StopMonitoringDelivery))
    throw new Error('bustime: not a SIRI StopMonitoring answer')
  const updatedAt = epoch(delivery.ResponseTimestamp) ?? null
  const errors = delivery.StopMonitoringDelivery.map(d => d.ErrorCondition).filter(e => e !== undefined)
  if (errors.length) {
    return { updatedAt, error: errorText(errors[0]!), visits: [] }
  }
  const visits: BusVisit[] = []
  for (const d of delivery.StopMonitoringDelivery) {
    for (const visit of d.MonitoredStopVisit ?? []) {
      const j = visit.MonitoredVehicleJourney
      const routeId = stripOperator(j?.LineRef)
      if (!j || !routeId) continue
      const call = j.MonitoredCall ?? {}
      const distances = call.Extensions?.Distances ?? {}
      const status = first(j.ProgressStatus)
      // SIRI 2 marks the journey; SIRI 1 marks its call.
      const cancelled = [j.VehicleStatus, call.ArrivalStatus, call.DepartureStatus].some(v =>
        /^cancell?ed$/i.test(v ?? '')
      )
      visits.push({
        routeId,
        publishedName: first(j.PublishedLineName),
        destination: first(j.DestinationName),
        tripId: j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ?? '',
        vehicle: stripOperator(j.VehicleRef),
        // A cancelled trip has no prediction: it is listed at its scheduled time.
        time: epoch(
          call.ExpectedArrivalTime ?? call.ExpectedDepartureTime ?? (cancelled ? call.AimedArrivalTime : undefined)
        ),
        distanceText: (call.ArrivalProximityText ?? distances.PresentableDistance ?? '').trim(),
        stopsAway: count(call.NumberOfStopsAway ?? distances.StopsFromCall),
        meters: count(call.DistanceFromStop ?? distances.DistanceFromCall),
        notYetDeparted: /layover|prevTrip/i.test(status),
        cancelled,
        stopName: first(call.StopPointName),
      })
    }
  }
  return { updatedAt, visits }
}

/** A bus on a route, as VehicleMonitoring describes it. */
export interface BusPosition {
  routeId: string
  publishedName: string
  destination: string
  tripId: string
  vehicle: string
  lat: number
  lon: number
  /** Degrees, counterclockwise from east as SIRI gives it; undefined when unknown. */
  bearing?: number
  /** Its next stop, by code (`MTA_` dropped) and name; empty when unknown. */
  stopId: string
  stopName: string
  distanceText: string
  stopsAway?: number
  notYetDeparted: boolean
  /** When the position was recorded, epoch seconds. */
  recordedAt?: number
}

export interface VehicleMonitoring {
  updatedAt: number | null
  /** Set when the API answered an error (`No such route: MTA NYCT_ZZZ.`). */
  error?: string
  vehicles: BusPosition[]
}

function errorText(e: NonNullable<SiriDelivery['ErrorCondition']>): string {
  return (e.OtherError?.ErrorText || e.Description || 'error').trim()
}

/**
 * Reads a VehicleMonitoring answer. A body that isn't SIRI throws; an `ErrorCondition` is
 * returned as `error`; a bus without a line ref or a position is skipped. Pure.
 */
export function parseVehicleMonitoring(body: unknown): VehicleMonitoring {
  const delivery = (body as SiriBody | null)?.Siri?.ServiceDelivery
  if (!delivery || !Array.isArray(delivery.VehicleMonitoringDelivery))
    throw new Error('bustime: not a SIRI VehicleMonitoring answer')
  const updatedAt = epoch(delivery.ResponseTimestamp) ?? null
  const error = delivery.VehicleMonitoringDelivery.map(d => d.ErrorCondition).find(e => e !== undefined)
  if (error) return { updatedAt, error: errorText(error), vehicles: [] }
  const vehicles: BusPosition[] = []
  for (const d of delivery.VehicleMonitoringDelivery) {
    for (const activity of d.VehicleActivity ?? []) {
      const j = activity.MonitoredVehicleJourney
      const routeId = stripOperator(j?.LineRef)
      const lat = j?.VehicleLocation?.Latitude
      const lon = j?.VehicleLocation?.Longitude
      if (!j || !routeId || typeof lat !== 'number' || typeof lon !== 'number') continue
      const call = j.MonitoredCall ?? {}
      vehicles.push({
        routeId,
        publishedName: first(j.PublishedLineName),
        destination: first(j.DestinationName),
        tripId: j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ?? '',
        vehicle: stripOperator(j.VehicleRef),
        lat,
        lon,
        bearing: typeof j.Bearing === 'number' && Number.isFinite(j.Bearing) ? j.Bearing : undefined,
        stopId: stripOperator(call.StopPointRef),
        stopName: first(call.StopPointName),
        distanceText: (call.ArrivalProximityText ?? '').trim(),
        stopsAway: count(call.NumberOfStopsAway),
        notYetDeparted: /layover|prevTrip/i.test(first(j.ProgressStatus)),
        recordedAt: epoch(activity.RecordedAtTime),
      })
    }
  }
  return { updatedAt, vehicles }
}

/**
 * One route's VehicleMonitoring answer, through the 15 s memo. Errors never carry the URL, which
 * holds the key.
 */
export function fetchVehicleMonitoring(
  route: string,
  key: string,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {}
): Promise<VehicleMonitoring> {
  return memoized(`bustime-vehicles:${route}`, now, async () => {
    const res = await fetcher(vehicleMonitoringUrl(route, key), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`bustime route ${route}: HTTP ${res.status}`)
    return parseVehicleMonitoring(await res.json())
  })
}

/**
 * One stop's StopMonitoring answer, through the 15 s memo. Errors never carry the URL, which holds
 * the key.
 */
export function fetchStopMonitoring(
  stop: string,
  key: string,
  { fetcher = fetch, now = Date.now(), timeoutMs = 8_000 }: { fetcher?: Fetcher; now?: number; timeoutMs?: number } = {}
): Promise<StopMonitoring> {
  return memoized(`bustime:${stop}`, now, async () => {
    const res = await fetcher(stopMonitoringUrl(stop, key), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`bustime stop ${stop}: HTTP ${res.status}`)
    return parseStopMonitoring(await res.json())
  })
}
