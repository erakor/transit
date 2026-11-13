/**
 * NYC Subway extensions to GTFS-realtime (`gtfs-realtime-NYCT.proto`, documented in the MTA's
 * "GTFS-realtime Reference for the New York City Subway"), read through `src/protowire.ts`.
 */
import { num, type FeedMessage } from '#src/gtfsrt.js'
import { extension, text, varint } from '#src/protowire.js'

// TripDescriptor.nyct_trip_descriptor = 1001: train_id = 1, is_assigned = 2.
const NYCT_TRIP_DESCRIPTOR = 1001
const TRAIN_ID = 1
const IS_ASSIGNED = 2

/** How a trip differs from its schedule, from the first character of its train id. */
export type TripChange = 'reroute' | 'skip-stop' | 'short-turn'

/** The trip type designators the reference documents; `0` is a scheduled trip. */
const CHANGES: Record<string, TripChange> = { '=': 'reroute', '/': 'skip-stop', $: 'short-turn' }

/**
 * Whether a physical train has been assigned to the trip (it is running or about to leave its
 * terminal; the feed also lists trips due to start in the next 30 minutes, which are likelier to
 * be changed or cancelled), and how the trip differs from its schedule, when its train id says.
 */
export function nyctTrip(trip: object | null | undefined): { assigned: boolean; change: TripChange | null } {
  const ext = extension(trip, NYCT_TRIP_DESCRIPTOR)
  const trainId = text(ext, TRAIN_ID) ?? ''
  return { assigned: varint(ext, IS_ASSIGNED) === 1, change: CHANGES[trainId[0] ?? ''] ?? null }
}

/**
 * A train is stalled when its position hasn't changed for this long before the feed's own
 * timestamp. Its predictions stop moving with it, so its times are too early. The reference
 * gives 90 seconds as the example, which station countdown clocks follow.
 */
export const STALLED_AFTER_S = 90

/**
 * Per trip id: whether the train is stalled (from the vehicle positions, whose timestamp is the
 * last time the train moved) and whether the feed reports it delayed (its "Train delayed"
 * alerts, which name trips).
 */
export function tripConditions(feed: FeedMessage): { stalled: Set<string>; delayed: Set<string> } {
  const stalled = new Set<string>()
  const delayed = new Set<string>()
  const now = num(feed.header?.timestamp)
  for (const entity of feed.entity) {
    const v = entity.vehicle
    const moved = num(v?.timestamp)
    const tripId = v?.trip?.tripId
    if (tripId && now !== undefined && moved !== undefined && now - moved > STALLED_AFTER_S) stalled.add(tripId)
    for (const e of entity.alert?.informedEntity ?? []) if (e.trip?.tripId) delayed.add(e.trip.tripId)
  }
  return { stalled, delayed }
}
