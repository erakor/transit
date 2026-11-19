/**
 * Response schemas for the routes of `src/routes/agency.ts` (`/lirr/...`, `/mnr/...`,
 * `/ferry/...` and their previews), and the types inferred from them.
 *
 * A stop is a `station` on the railroads and a `stop` on the ferry, in the answer too, so the
 * schemas that name one come in both forms (`STOP_SCHEMAS`; the requests are `STOP_QUERIES` in `queries.ts`).
 */
import * as z from 'zod'
import { keyed } from '#src/query.js'
import type { StopParam } from './types.js'
import {
  AlertsResult,
  EpochSeconds,
  FeedUpdatedAt,
  Latitude,
  Longitude,
  RouteDisplay,
  RouteFields,
  StopRef,
  VehicleStatus,
} from '#src/schema.js'

export const AgencyArrival = z.strictObject({
  time: EpochSeconds.meta({
    description: 'When it leaves this stop, or arrives where its trip ends.',
  }),
  delay: z
    .int()
    .optional()
    .meta({ description: 'Seconds behind schedule (negative: ahead), when the feed says.' }),
  track: z.string().optional().meta({
    description:
      'LIRR and Metro-North: the track it uses at this station (`2`, `2A`, `204`), when the railroad has posted it.',
  }),
  status: z.string().optional().meta({
    description:
      "Metro-North: the train's status at this station, as the railroad words it (`On-Time`, `Late`, `Arriving`, `Departed`, `Bus` for a bus substitute).",
  }),
  ...RouteFields,
  headsign: z.string().meta({ description: 'Where the trip ends.' }),
  tripId: z.string(),
})

/** What `computeAgencyArrivals()` returns: the response before the route names `stop` after the agency. */
export const AgencyArrivalsResult = z.strictObject({
  stop: StopRef,
  updatedAt: FeedUpdatedAt,
  arrivals: z.array(AgencyArrival).meta({
    description: 'Every route and direction in one list, soonest first, like a departure board.',
  }),
})

export const AgencyVehicle = z.strictObject({
  id: z.string(),
  label: z.string().meta({
    description:
      'The number riders and crews know it by (train number, boat name); empty when the feed has none.',
  }),
  tripId: z.string(),
  route: RouteDisplay.nullable(),
  headsign: z.string().meta({ description: 'Where its trip ends, empty when unknown.' }),
  lat: Latitude,
  lon: Longitude,
  status: VehicleStatus.nullable().meta({
    description: "Relative to `stop`; null when the feed doesn't say.",
  }),
  stop: StopRef.nullable(),
  time: EpochSeconds.nullable().meta({ description: 'When the position was measured.' }),
})

export const AgencyVehiclesResponse = z.strictObject({
  updatedAt: EpochSeconds.nullable().meta({
    description: 'Oldest header timestamp among the feeds used.',
  }),
  vehicles: z
    .array(AgencyVehicle)
    .meta({ description: 'By route name. Positions older than 15 minutes are left out.' }),
})

/** The schemas that name the stop `p`. */
function stopSchemas(p: StopParam) {
  const { stop, ...result } = AgencyArrivalsResult.shape
  const ArrivalsResponse = z.strictObject({ ...keyed(p, stop), ...result })

  const Stop = StopRef.extend({
    id: z.string().meta({ description: 'GTFS stop id. Stable: store it as a favorite.' }),
    lat: Latitude,
    lon: Longitude,
    routes: z.array(RouteDisplay).meta({ description: 'Routes with scheduled service here.' }),
  })

  const StopsResponse = z.strictObject({
    query: z
      .string()
      .optional()
      .meta({ description: 'The search text, trimmed, when there was one.' }),
    ...keyed(`${p}s`, z.array(Stop)),
  })

  const AlertsResponse = AlertsResult.extend({
    ...keyed(p, StopRef.optional().meta({ description: `The ${p}, when \`${p}\` was given.` })),
  })

  return { ArrivalsResponse, StopsResponse, AlertsResponse }
}

export const STOP_SCHEMAS = { station: stopSchemas('station'), stop: stopSchemas('stop') }

export type AgencyArrival = z.infer<typeof AgencyArrival>
export type AgencyArrivalsResult = z.infer<typeof AgencyArrivalsResult>
export type AgencyVehicle = z.infer<typeof AgencyVehicle>
export type AgencyVehiclesResponse = z.infer<typeof AgencyVehiclesResponse>
