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

const BASE = 'https://bustime.mta.info/api/siri/stop-monitoring.json'

/** A stop code as riders see it on the stop's sign, and as the API takes it after `MTA_`. */
export const STOP_CODE = /^\d{6}$/

/** The request for one stop: SIRI 2, every operator (MTA New York City Transit and MTA Bus). */
export function stopMonitoringUrl(stop: string, key: string): string {
  const query = new URLSearchParams({
    key,
    version: '2',
    OperatorRef: 'MTA',
    MonitoringRef: stop,
    StopMonitoringDetailLevel: 'minimum',
  })
  return `${BASE}?${query}`
}

interface SiriCall {
  ExpectedArrivalTime?: string
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
  MonitoredCall?: SiriCall
}

interface SiriDelivery {
  MonitoredStopVisit?: { MonitoredVehicleJourney?: SiriJourney }[]
  ErrorCondition?: { Description?: string; OtherError?: { ErrorText?: string } }
}

interface SiriBody {
  Siri?: {
    ServiceDelivery?: {
      ResponseTimestamp?: string
      StopMonitoringDelivery?: SiriDelivery[]
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
    const e = errors[0]!
    return { updatedAt, error: (e.OtherError?.ErrorText || e.Description || 'error').trim(), visits: [] }
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
      visits.push({
        routeId,
        publishedName: first(j.PublishedLineName),
        destination: first(j.DestinationName),
        tripId: j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ?? '',
        vehicle: stripOperator(j.VehicleRef),
        time: epoch(call.ExpectedArrivalTime ?? call.ExpectedDepartureTime),
        distanceText: (call.ArrivalProximityText ?? distances.PresentableDistance ?? '').trim(),
        stopsAway: count(call.NumberOfStopsAway ?? distances.StopsFromCall),
        meters: count(call.DistanceFromStop ?? distances.DistanceFromCall),
        notYetDeparted: /layover|prevTrip/i.test(status),
        stopName: first(call.StopPointName),
      })
    }
  }
  return { updatedAt, visits }
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
