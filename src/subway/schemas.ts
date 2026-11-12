/**
 * Request and response schemas for `/subway/arrivals`, and the types inferred from them. Response
 * objects are `z.strictObject` so the tests catch a field the schema doesn't list.
 */
import * as z from 'zod'
import { countParam, EpochSeconds, HexColor, requiredParam } from '#src/schema.js'

export const ArrivalsQuery = z.object({
  stop: requiredParam(
    'stop',
    'A station id from /stops/search (stop ids joined with `+`, such as `127+725+902+A27+R16`), ' +
      'a GTFS stop id (`127`) or one platform (`127N`). Case insensitive.'
  ),
  limit: countParam('limit', 3, 10, 'Trains per route and direction.'),
})

export const Arrival = z.strictObject({
  time: EpochSeconds.meta({ description: 'When the train reaches the stop (epoch seconds).' }),
  headsign: z.string().meta({ description: "Name of the trip's last passenger stop in the feed." }),
  tripId: z.string(),
})

export const RouteDirectionArrivals = z.strictObject({
  route: z.string().meta({ description: 'GTFS route id. Diamond express trips keep their own (`6X`, `7X`, `FX`).' }),
  name: z.string().meta({ description: 'Rider-facing route name (`S` for the shuttles).' }),
  color: HexColor,
  textColor: HexColor,
  direction: z.enum(['N', 'S']).meta({ description: "The MTA's northbound or southbound platform." }),
  headsign: z.string().meta({ description: 'Headsign of the next train.' }),
  arrivals: z.array(Arrival),
})

export const ArrivalsResult = z.strictObject({
  stop: z.strictObject({
    id: z.string(),
    name: z.string(),
    stops: z.array(z.string()).meta({ description: 'GTFS stop ids the station is made of.' }),
  }),
  updatedAt: EpochSeconds.nullable().meta({
    description: 'Oldest header timestamp among the feeds used; null when no feed serves the stop.',
  }),
  groups: z.array(RouteDirectionArrivals).meta({ description: 'In MTA route order, then `N` before `S`.' }),
})

/** What the route answers: the computed result, plus the feeds that failed when some did. */
export const ArrivalsResponse = ArrivalsResult.extend({
  unavailableFeeds: z
    .array(z.string())
    .optional()
    .meta({ description: 'Present when some upstream feeds failed; their groups are missing.' }),
})

export type Arrival = z.infer<typeof Arrival>
export type RouteDirectionArrivals = z.infer<typeof RouteDirectionArrivals>
export type ArrivalsResult = z.infer<typeof ArrivalsResult>
export type ArrivalsResponse = z.infer<typeof ArrivalsResponse>
