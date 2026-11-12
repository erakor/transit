/**
 * Request and response schemas for the bus routes of `src/routes/bus.ts` (`/bus/arrivals`,
 * `/preview/bus`, `/bus/alerts`), and the types inferred from them.
 */
import * as z from 'zod'
import { countParam, EpochSeconds, FeedUpdatedAt, optionalParam, requiredParam, RouteFields } from '#src/schema.js'

const STOP_DESCRIPTION =
  'The six-digit stop code on the bus stop sign (`308209`), as Bus Time knows it. Stable: store it as a favorite.'

/** Six digits; a leading `MTA_`, as Bus Time writes stop refs, is accepted and dropped. */
const stopCode = requiredParam('stop', STOP_DESCRIPTION)
  .transform(s => s.replace(/^MTA_/i, ''))
  .pipe(z.string().regex(/^\d{6}$/, { error: 'stop must be a six-digit bus stop code' }))

export const BusArrivalsQuery = z.object({
  stop: stopCode,
  limit: countParam('limit', 10, 30, 'Buses to return.'),
})

export const BusPreviewQuery = z.object({ stop: stopCode })

export const BusArrival = z.strictObject({
  time: EpochSeconds.nullable().meta({
    description: 'Predicted arrival. Null when Bus Time has no prediction, usually for a bus still at its terminal.',
  }),
  ...RouteFields,
  route: RouteFields.route.meta({ description: 'GTFS route id (`M15+`), as in `/bus/alerts`.' }),
  headsign: z.string().meta({ description: 'Where the trip ends, as the bus shows it.' }),
  distance: z.string().meta({
    description: "Bus Time's distance for riders: `approaching`, `2 stops away`, `1.3 miles away`. Empty when unknown.",
  }),
  stopsAway: z.int().nonnegative().nullable(),
  meters: z.int().nonnegative().nullable().meta({ description: 'Distance along the route.' }),
  atTerminal: z.boolean().meta({
    description: 'The bus is waiting to start its trip or still finishing its previous one, so its time is less sure.',
  }),
  vehicle: z.string().meta({ description: 'The bus number; empty when unknown.' }),
  tripId: z.string(),
})

export const BusArrivalsResponse = z.strictObject({
  stop: z.strictObject({
    id: z.string(),
    name: z.string().nullable().meta({ description: 'From Bus Time; null when no bus is on its way to tell it.' }),
  }),
  updatedAt: FeedUpdatedAt.meta({ description: "Bus Time's response timestamp." }),
  arrivals: z.array(BusArrival).meta({
    description: 'Every route in one list: soonest first, then buses without a prediction, nearest first.',
  }),
})

export const BusAlertsQuery = z.object({
  route: optionalParam('route', 'Only alerts about this bus route id (`M15`, `B44+`). Case insensitive.'),
})

export type BusArrival = z.infer<typeof BusArrival>
export type BusArrivalsResponse = z.infer<typeof BusArrivalsResponse>
