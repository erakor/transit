/** Request and response schemas for the PATH routes, and the types inferred from them. */
import * as z from 'zod'
import {
  countParam,
  EpochSeconds,
  HexColor,
  optionalParam,
  requiredParam,
  RouteDisplay,
  MAX_QUERY_LENGTH,
  StopRef,
} from '#src/schema.js'

const STATION_DESCRIPTION = 'A station id from /path/stations (`WTC`, `HOB`, `09S`). Case insensitive.'

export const PathArrivalsQuery = z.object({
  station: requiredParam('station', STATION_DESCRIPTION),
  limit: countParam('limit', 3, 10, 'Trains per route and direction.'),
})

export const PathArrival = z.strictObject({
  time: EpochSeconds.meta({
    description: 'When the train reaches the station. A train at the platform stays listed for 2 minutes after it.',
  }),
  headsign: z.string(),
})

export const PathRouteDirectionArrivals = z.strictObject({
  route: z.string().meta({
    description: "PATH route id (`HOB-WTC`, `JSQ-33-HOB`). A line color PATH hasn't used before shows under its color.",
  }),
  name: z.string(),
  color: HexColor,
  textColor: HexColor,
  direction: z
    .enum(['NY', 'NJ'])
    .meta({ description: '`NY` toward Manhattan or `NJ`, as the feed labels the train at this station.' }),
  headsign: z.string().meta({ description: 'Headsign of the next train.' }),
  arrivals: z.array(PathArrival),
})

export const PathArrivalsResponse = z.strictObject({
  station: StopRef,
  updatedAt: EpochSeconds.nullable().meta({
    description: "Oldest update time among the station's trains in the feed; null when it lists none.",
  }),
  groups: z
    .array(PathRouteDirectionArrivals)
    .meta({ description: "In PATH's route order, then toward New York before New Jersey." }),
})

export const PathStationsQuery = z.object({})

export const PathStationsResponse = z.strictObject({
  stations: z.array(
    StopRef.extend({
      id: z.string().meta({ description: "The feed's station code. Stable: store it as a favorite." }),
      routes: z.array(RouteDisplay).meta({ description: "Routes with scheduled service, in PATH's order." }),
    })
  ),
})

export const PathPreviewQuery = z
  .object({
    q: optionalParam('q', 'A station name (`hoboken`, `wtc`, `journal sq`): the best match is used.', MAX_QUERY_LENGTH),
    station: optionalParam('station', `Instead of \`q\`. ${STATION_DESCRIPTION}`),
  })
  .refine(query => query.q || query.station, { error: 'q or station is required' })

export type PathArrival = z.infer<typeof PathArrival>
export type PathRouteDirectionArrivals = z.infer<typeof PathRouteDirectionArrivals>
export type PathArrivalsResponse = z.infer<typeof PathArrivalsResponse>
export type PathStationsResponse = z.infer<typeof PathStationsResponse>
