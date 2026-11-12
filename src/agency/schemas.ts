/**
 * Request and response schemas for the routes of `src/routes/agency.ts` (`/lirr/...`, `/mnr/...`,
 * `/ferry/...`, their previews and `/bus/alerts`), and the types inferred from them.
 *
 * A stop is a `station` on the railroads and a `stop` on the ferry, in the query and in the
 * answer, so the schemas that name one come in both forms (`STOP_SCHEMAS`). Their queries all
 * read it as `stop`, so the handler is the same for both.
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

/** What a stop is called in the API: `/lirr/arrivals?station=`, `/ferry/arrivals?stop=`. */
export type StopParam = 'station' | 'stop'

const ROUTE_DESCRIPTION = 'Only this route id (from `routes` in the station list). Case insensitive.'

export const AgencyArrival = z.strictObject({
  time: EpochSeconds.meta({ description: 'When it leaves this stop, or arrives where its trip ends.' }),
  delay: z.int().optional().meta({ description: 'Seconds behind schedule (negative: ahead), when the feed says.' }),
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

export const AgencyVehiclesQuery = z.object({ route: optionalParam('route', ROUTE_DESCRIPTION) })

export const AgencyVehicle = z.strictObject({
  id: z.string(),
  label: z.string().meta({
    description: 'The number riders and crews know it by (train number, boat name); empty when the feed has none.',
  }),
  tripId: z.string(),
  route: RouteDisplay.nullable(),
  headsign: z.string().meta({ description: 'Where its trip ends, empty when unknown.' }),
  lat: Latitude,
  lon: Longitude,
  status: VehicleStatus.nullable().meta({ description: "Relative to `stop`; null when the feed doesn't say." }),
  stop: StopRef.nullable(),
  time: EpochSeconds.nullable().meta({ description: 'When the position was measured.' }),
})

export const AgencyVehiclesResponse = z.strictObject({
  updatedAt: EpochSeconds.nullable().meta({ description: 'Oldest header timestamp among the feeds used.' }),
  vehicles: z
    .array(AgencyVehicle)
    .meta({ description: 'By route name. Positions older than 15 minutes are left out.' }),
})

export const BusAlertsQuery = z.object({
  route: optionalParam('route', 'Only alerts about this bus route id (`M15`, `B44+`). Case insensitive.'),
})

/**
 * `{ [key]: schema }`. TypeScript widens a computed key to `string`, and zod's types don't follow
 * a generic one, so the type lists every key `key` can be: the query transforms below read the
 * one there is, and the response schemas are for the tests and docs, which need no types.
 */
function keyed<K extends string, T>(key: K, schema: T) {
  return { [key]: schema } as Record<K, T>
}

/** The schemas that name the stop `p`. */
function stopSchemas(p: StopParam) {
  const description = `A ${p} id from /<agency>/${p}s. Case insensitive.`

  const ArrivalsQuery = z
    .object({
      ...keyed(p, requiredParam(p, description)),
      limit: countParam('limit', 10, 30, 'Departures to return.'),
    })
    .transform(query => ({ stop: query[p], limit: query.limit }))

  const { stop, ...result } = AgencyArrivalsResult.shape
  const ArrivalsResponse = z.strictObject({ ...keyed(p, stop), ...result })

  const StopsQuery = z.object({
    q: optionalParam(
      'q',
      `Only ${p}s matching this name, best first. Without it, all of them by name.`,
      MAX_QUERY_LENGTH
    ),
    limit: countParam('limit', 10, 25, `${p}s to return with \`q\`.`),
  })

  const Stop = StopRef.extend({
    id: z.string().meta({ description: 'GTFS stop id. Stable: store it as a favorite.' }),
    lat: Latitude,
    lon: Longitude,
    routes: z.array(RouteDisplay).meta({ description: 'Routes with scheduled service here.' }),
  })

  const StopsResponse = z.strictObject({
    query: z.string().optional().meta({ description: 'The search text, trimmed, when there was one.' }),
    ...keyed(`${p}s`, z.array(Stop)),
  })

  const AlertsQuery = z
    .object({
      route: optionalParam('route', ROUTE_DESCRIPTION),
      ...keyed(p, optionalParam(p, `Only alerts naming this ${p}, or a whole route that stops there. ${description}`)),
    })
    .transform(query => ({ route: query.route, stop: query[p] }))

  const AlertsResponse = AlertsResult.extend({
    ...keyed(p, StopRef.optional().meta({ description: `The ${p}, when \`${p}\` was given.` })),
  })

  const PreviewQuery = previewQuery(p, `A ${p} name: the best match is used.`, description)

  return { ArrivalsQuery, ArrivalsResponse, StopsQuery, StopsResponse, AlertsQuery, AlertsResponse, PreviewQuery }
}

export const STOP_SCHEMAS = { station: stopSchemas('station'), stop: stopSchemas('stop') }

export type AgencyArrival = z.infer<typeof AgencyArrival>
export type AgencyArrivalsResult = z.infer<typeof AgencyArrivalsResult>
export type AgencyVehicle = z.infer<typeof AgencyVehicle>
export type AgencyVehiclesResponse = z.infer<typeof AgencyVehiclesResponse>
