/**
 * Building blocks for request and response schemas (zod), shared by every provider.
 *
 * A schema is a value that still exists at runtime, unlike a TypeScript interface, so the same
 * definition gives us three things: a type (`z.infer`), a check (`schema.safeParse`), and later a
 * JSON Schema for the API docs (`z.toJSONSchema`). Descriptions go in `.meta()` rather than in
 * comments so they end up in those docs too.
 */
import * as z from 'zod'
import { errorResponse } from './http.js'

/** Times in responses: whole seconds since the Unix epoch. */
export const EpochSeconds = z.int().nonnegative().meta({ description: 'Epoch seconds.' })

/** Route colors: `#` and six uppercase hex digits, as the static data stores them. */
export const HexColor = z.string().regex(/^#[0-9A-F]{6}$/)

/** The body of every 4xx and 5xx answer. */
export const ErrorBody = z.strictObject({ error: z.string() })

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

export const Alert = z.strictObject({
  id: z.string(),
  planned: z.boolean().meta({ description: 'Scheduled work rather than something that just happened.' }),
  header: z.string().meta({
    description: 'One or two plain-text sentences. Subway texts name routes in brackets: `[A][C] trains`.',
  }),
  description: z.string().meta({ description: 'Longer plain text, empty when there is none.' }),
  routes: z.array(RouteDisplay),
  stops: z.array(StopRef).meta({ description: 'Stops the alert names, when the static data knows them.' }),
  start: EpochSeconds.nullable().meta({ description: 'Start of the period in effect now; null when open.' }),
  end: EpochSeconds.nullable().meta({ description: 'End of the period in effect now; null when open.' }),
})

export const AlertsResult = z.strictObject({
  updatedAt: FeedUpdatedAt,
  alerts: z.array(Alert).meta({ description: 'In effect now: current events first, then planned work; newest first.' }),
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
export type Alert = z.infer<typeof Alert>
export type AlertsResult = z.infer<typeof AlertsResult>
export type HealthResponse = z.infer<typeof HealthResponse>

/** The longest search text (`q`) routes accept. */
export const MAX_QUERY_LENGTH = 100

/**
 * A required query parameter, trimmed. Missing, empty and blank all answer "<name> is required";
 * longer than `maxLength`, "<name> is too long". The custom `error` replaces zod's default
 * messages ("Invalid input: expected string, received undefined") with the ones this API has
 * always answered.
 */
export function requiredParam(name: string, description: string, maxLength?: number) {
  const error = `${name} is required`
  return capped(z.string({ error }).trim().min(1, { error }), name, maxLength).meta({ description })
}

/** An optional query parameter, trimmed; blank reads as absent (`undefined`). */
export function optionalParam(name: string, description: string, maxLength?: number) {
  return capped(z.string().trim(), name, maxLength)
    .transform(s => s || undefined)
    .optional()
    .meta({ description })
}

function capped(text: z.ZodString, name: string, maxLength: number | undefined): z.ZodString {
  return maxLength === undefined ? text : text.max(maxLength, { error: `${name} is too long` })
}

/**
 * Count and coordinate parameters are checked as text, since that is what arrives, but are numbers
 * to clients: `asNumber` in their `.meta()` is the JSON Schema the docs show instead of the text
 * rule (`src/openapi.ts`).
 */
declare module 'zod' {
  interface GlobalMeta {
    asNumber?: { type: 'integer' | 'number'; minimum: number; maximum?: number; default?: number }
  }
}

/** Digits only: the text a count parameter accepts. */
const DIGITS = /^\d+$/

/**
 * An optional positive integer query parameter: `fallback` when absent, clamped to `max` when
 * larger (a too-large value is not an error, so clients can ask for "as many as you allow").
 *
 * Query parameters are strings, so the schema checks the text first: digits only.
 * (`z.coerce.number()` would be shorter, but `Number()` also reads "1e1", "0x10" and " 5".) The
 * transforms then turn it into a number; the JSON Schema for requests shows the text rule, which
 * is what clients send.
 *
 * `.prefault()` rather than `.default()`: a default is an output value and skips the schema, a
 * prefault is fed in as input and goes through it. The result is the same here, but zod leaves
 * a default that follows a transform out of the JSON Schema it generates for requests.
 */
export function countParam(name: string, fallback: number, max: number, description: string) {
  const error = `${name} must be a positive integer`
  return (
    z
      .string()
      .regex(DIGITS, { error })
      // Clamp before the int check: z.int() rejects values past 2^53, which this API lowers to max.
      .transform(s => Math.min(Number(s), max))
      .pipe(z.int().min(1, { error }))
      .prefault(String(fallback))
      .meta({
        description: `${description} Default ${fallback}, at most ${max} (larger values are lowered to ${max}).`,
        asNumber: { type: 'integer', minimum: 1, default: fallback },
      })
  )
}

/** A decimal number, as a coordinate parameter accepts it (`Number()` also reads `0x10` and `0b1`). */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/**
 * A required coordinate query parameter: a decimal number between `-max` and `max`. Like a count
 * parameter, it is text checked first and then turned into a number.
 */
export function coordinateParam(name: string, max: number, description: string) {
  const required = { error: `${name} is required` }
  const range = { error: `${name} must be a number between -${max} and ${max}` }
  return (
    z
      .string(required)
      .trim()
      .min(1, required)
      .regex(DECIMAL, range)
      .transform(Number)
      // `range` on the type too: an exponent that overflows (`1e999`) is Infinity, which z.number() rejects.
      .pipe(z.number(range).min(-max, range).max(max, range))
      .meta({ description, asNumber: { type: 'number', minimum: -max, maximum: max } })
  )
}

/**
 * The query of a preview route: `q`, a name to search, or `param`, an id that wins over it. The
 * output says which was given, `{ id }` or `{ q }`, so handlers branch without assertions.
 */
export function previewQuery(param: string, qDescription: string, paramDescription: string) {
  return z
    .object({
      q: optionalParam('q', qDescription, MAX_QUERY_LENGTH),
      [param]: optionalParam(param, `Instead of \`q\`. ${paramDescription}`),
    })
    .transform((query, ctx): { id: string; q?: undefined } | { id?: undefined; q: string } => {
      const id = query[param]
      if (id) return { id }
      if (query.q) return { q: query.q }
      ctx.addIssue({ code: 'custom', message: `q or ${param} is required` })
      return z.NEVER
    })
}

/**
 * Validates a request's query string against `schema`. Returns the parsed, typed values, or a
 * ready 400 response carrying the first problem's message.
 *
 * A repeated parameter keeps its first value, like `URLSearchParams.get()`. Empty values
 * (`?limit=`) then count as absent, so they get the default or the "is required" error.
 * Parameters the schema doesn't name are ignored (`z.object` strips unknown keys).
 */
export function parseQuery<S extends z.ZodType>(
  schema: S,
  url: URL
): { ok: true; query: z.output<S> } | { ok: false; response: Response } {
  // No prototype, so names like `constructor` are ordinary keys.
  const raw: Record<string, string> = Object.create(null)
  for (const [key, value] of url.searchParams) if (!(key in raw)) raw[key] = value
  for (const key in raw) if (raw[key] === '') delete raw[key]
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, query: parsed.data }
  return { ok: false, response: errorResponse(400, parsed.error.issues[0]?.message ?? 'invalid query') }
}
