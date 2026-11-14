/**
 * Building blocks for response schemas (zod), shared by every provider. Request parameters are in `query.ts`,
 * so a route that only reads a query doesn't load the response schemas.
 *
 * A schema is a value that still exists at runtime, unlike a TypeScript interface, so the same
 * definition gives us three things: a type (`z.infer`), a check (`schema.safeParse`), and later a
 * JSON Schema for the API docs (`z.toJSONSchema`). Descriptions go in `.meta()` rather than in
 * comments so they end up in those docs too.
 */
import * as z from 'zod'
import { ERROR_CODES } from './errors.js'

/** Times in responses: whole seconds since the Unix epoch. */
export const EpochSeconds = z.int().nonnegative().meta({ description: 'Epoch seconds.' })

/** Route colors: `#` and six uppercase hex digits, as the static data stores them. */
export const HexColor = z.string().regex(/^#[0-9A-F]{6}$/)

/** The body of every 4xx and 5xx answer. */
export const ErrorBody = z.strictObject({
  error: z.string().meta({ description: 'Human-readable message; the wording may change.' }),
  code: z.enum(ERROR_CODES).meta({ description: 'Stable machine-readable error code.' }),
})

export const Latitude = z.number().min(-90).max(90)
export const Longitude = z.number().min(-180).max(180)

/** How a route is shown: every response that names a route carries these. */
export const RouteDisplay = z.strictObject({
  id: z.string(),
  name: z.string().meta({ description: 'Rider-facing route name.' }),
  color: HexColor,
  textColor: HexColor,
})

/** A route's display fields, flattened into a group of arrivals: spread them, and override `route`'s description. */
export const RouteFields = {
  route: z.string().meta({ description: 'Route id.' }),
  name: RouteDisplay.shape.name,
  color: HexColor,
  textColor: HexColor,
}

/** A stop or station named in a response. */
export const StopRef = z.strictObject({ id: z.string(), name: z.string() })

export const FeedUpdatedAt = EpochSeconds.nullable().meta({ description: "The feed's header timestamp." })

/**
 * `VehiclePosition.current_status`. Spelled out rather than imported from `gtfsrt.ts`, which would
 * bundle the protobuf bindings into functions that decode no feed; `VEHICLE_STATUS` there is
 * checked against this.
 */
export const VehicleStatus = z
  .enum(['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'])
  .meta({ description: 'GTFS-realtime `current_status`, relative to `stop`.' })

/** A stop an alert names. */
export const AlertStop = StopRef.extend({
  direction: z.enum(['N', 'S']).nullable().meta({
    description:
      "Subway only: the one direction the alert affects there, the MTA's northbound (`N`) or southbound (`S`) platform. Null when it affects both or the feed doesn't say.",
  }),
})

export const Alert = z.strictObject({
  id: z.string().meta({
    description:
      "The MTA's alert id, without the status rank it appends to its entity ids, so it stays the same when the status changes.",
  }),
  planned: z.boolean().meta({ description: 'Scheduled work rather than something that just happened.' }),
  category: z.string().nullable().meta({
    description:
      "The MTA's status for the alert, such as `Delays`, `Part Suspended` or `Planned - Stops Skipped`: one of the 35 names in the MTA's status table. Null when the feed has none (NYC Ferry).",
  }),
  priority: z.number().int().min(1).max(35).nullable().meta({
    description:
      "The status's rank in the MTA's table, from 1 (`No Scheduled Service`) to 35 (`Suspended`); higher is more serious. Null with `category`.",
  }),
  header: z.string().meta({
    description: 'One or two plain-text sentences. Subway texts name routes in brackets: `[A][C] trains`.',
  }),
  description: z.string().meta({ description: 'Longer plain text, empty when there is none.' }),
  routes: z.array(RouteDisplay),
  stops: z.array(AlertStop).meta({ description: 'Stops the alert names, when the static data knows them.' }),
  start: EpochSeconds.nullable().meta({ description: 'Start of the period in effect now; null when open.' }),
  end: EpochSeconds.nullable().meta({ description: 'End of the period in effect now; null when open.' }),
})

export const AlertsResult = z.strictObject({
  updatedAt: FeedUpdatedAt,
  alerts: z.array(Alert).meta({
    description: 'In effect now: current events first, then planned work; by priority, then newest first.',
  }),
})

/** `/health`, the one route without a token. */
export const HealthResponse = z.strictObject({
  ok: z.literal(true),
  staticFeedVersion: z.string().meta({ description: 'feed_version of the deployed subway schedule.' }),
  time: EpochSeconds.meta({ description: "The server's clock." }),
})

export type RouteDisplay = z.infer<typeof RouteDisplay>
export type StopRef = z.infer<typeof StopRef>
export type VehicleStatus = z.infer<typeof VehicleStatus>
export type AlertStop = z.infer<typeof AlertStop>
export type Alert = z.infer<typeof Alert>
export type AlertsResult = z.infer<typeof AlertsResult>
export type HealthResponse = z.infer<typeof HealthResponse>
