/**
 * Request and response schemas for the subway routes (`/subway/...`, `/stops/search` and
 * `/preview/subway`), and the types inferred from them. Response objects are `z.strictObject` so
 * the tests catch a field the schema doesn't list.
 */
import * as z from 'zod'
import {
  AlertsResult,
  countParam,
  EpochSeconds,
  FeedUpdatedAt,
  Latitude,
  Longitude,
  MAX_QUERY_LENGTH,
  optionalParam,
  previewQuery,
  requiredParam,
  RouteDisplay,
  RouteFields,
  StopRef,
  VehicleStatus,
} from '#src/schema.js'

const STOP_DESCRIPTION =
  'A station id from /stops/search (stop ids joined with `+`, such as `127+725+902+A27+R16`), ' +
  'a GTFS stop id (`127`) or one platform (`127N`). Case insensitive.'

export const ArrivalsQuery = z.object({
  stop: requiredParam('stop', STOP_DESCRIPTION),
  limit: countParam('limit', 3, 10, 'Trains per route and direction.'),
})

export const Arrival = z.strictObject({
  time: EpochSeconds.meta({ description: 'When the train reaches the stop (epoch seconds).' }),
  headsign: z.string().meta({ description: "Name of the trip's last passenger stop in the feed." }),
  tripId: z.string(),
  assigned: z.boolean().meta({
    description:
      'A train has been assigned to the trip: it is running or about to leave its terminal. The feed also lists trips due to start in the next 30 minutes before a train is assigned; those are likelier to be changed or cancelled.',
  }),
  change: z.enum(['reroute', 'skip-stop', 'short-turn']).nullable().meta({
    description:
      "How the trip differs from its schedule, when the MTA marks it: rerouted, skipping stops, or turned short of its usual terminal. Null for a scheduled trip, and when the feed doesn't say (the B Division routes mark changes differently).",
  }),
  stalled: z.boolean().meta({
    description:
      "The train hasn't moved for over 90 seconds. Its predictions stop with it, so `time` is too early; station countdown clocks stop counting down then.",
  }),
  delayed: z.boolean().meta({ description: 'The feed reports the train delayed ("Train delayed").' }),
})

export const RouteDirectionArrivals = z.strictObject({
  ...RouteFields,
  route: z.string().meta({ description: 'GTFS route id. Diamond express trips keep their own (`6X`, `7X`, `FX`).' }),
  name: z.string().meta({ description: 'Rider-facing route name (`S` for the shuttles).' }),
  direction: z.enum(['N', 'S']).meta({ description: "The MTA's northbound or southbound platform." }),
  headsign: z.string().meta({ description: 'Headsign of the next train.' }),
  arrivals: z.array(Arrival),
})

/** A station as the arrivals and alerts name it. */
const Station = StopRef.extend({
  stops: z.array(z.string()).meta({ description: 'GTFS stop ids the station is made of.' }),
})

export const ArrivalsResult = z.strictObject({
  stop: Station,
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

export const SearchQuery = z.object({
  q: requiredParam('q', 'Station name, or part of one (`times sq`, `bedford`).', MAX_QUERY_LENGTH),
  limit: countParam('limit', 10, 25, 'Stations to return.'),
})

export const SearchResult = StopRef.extend({
  id: z.string().meta({ description: 'Station id, for `stop` in the other routes. Stable: store it as a favorite.' }),
  lat: Latitude,
  lon: Longitude,
  stops: z.array(StopRef).meta({ description: 'The GTFS stops (parent stations) it is made of.' }),
  routes: z
    .array(RouteDisplay)
    .meta({ description: 'Routes scheduled here, in MTA order. Diamond express variants are left out.' }),
})

export const SearchResponse = z.strictObject({
  query: z.string().meta({ description: 'The search text, trimmed.' }),
  results: z.array(SearchResult).meta({ description: 'Best match first.' }),
})

export const AlertsQuery = z.object({
  route: optionalParam('route', 'Only alerts about this route id (`A`, `6X`). Case insensitive.'),
  stop: optionalParam(
    'stop',
    `Only alerts naming one of this station's stops, or a whole route that stops there. ${STOP_DESCRIPTION}`
  ),
})

export const AlertsResponse = AlertsResult.extend({
  stop: Station.optional().meta({ description: 'The station `stop` resolved to, when given.' }),
})

export const VehiclesQuery = z.object({
  route: requiredParam('route', 'A route id (`A`, `6X`). Case insensitive.'),
})

export const SubwayTrain = z.strictObject({
  tripId: z.string(),
  direction: z
    .enum(['N', 'S'])
    .nullable()
    .meta({ description: 'From the platform the train is at or heading to; null when unknown.' }),
  headsign: z.string().meta({ description: "Name of the trip's last passenger stop in the feed, empty when unknown." }),
  status: VehicleStatus,
  stop: StopRef.nullable().meta({ description: 'The stop the train is at or heading to; null when unknown.' }),
  time: EpochSeconds.nullable().meta({ description: 'When the train last reported.' }),
})

export const VehiclesResponse = z.strictObject({
  route: RouteDisplay,
  updatedAt: FeedUpdatedAt,
  vehicles: z
    .array(SubwayTrain)
    .meta({ description: 'Northbound first, each direction in stop id order. The feeds carry no coordinates.' }),
})

export const PreviewQuery = previewQuery(
  'stop',
  'A station name: the best /stops/search match is used.',
  STOP_DESCRIPTION
)

export type Arrival = z.infer<typeof Arrival>
export type RouteDirectionArrivals = z.infer<typeof RouteDirectionArrivals>
export type ArrivalsResult = z.infer<typeof ArrivalsResult>
export type ArrivalsResponse = z.infer<typeof ArrivalsResponse>
export type SearchResponse = z.infer<typeof SearchResponse>
export type AlertsResponse = z.infer<typeof AlertsResponse>
export type SubwayTrain = z.infer<typeof SubwayTrain>
export type VehiclesResponse = z.infer<typeof VehiclesResponse>
