/**
 * Building blocks for request schemas (zod) and reading a query string, shared by every provider. Kept apart from
 * `schema.ts` (the response schemas) so the functions only bundle what they run: the routes import this, and the
 * response schemas only the docs generator and the tests load.
 */
import * as z from 'zod'
import { errorResponse } from './http.js'

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
  return { ok: false, response: errorResponse('invalid_parameter', parsed.error.issues[0]?.message ?? 'invalid query') }
}

/**
 * `{ [key]: schema }`. TypeScript widens a computed key to `string`, and zod's types don't follow
 * a generic one, so the type lists every key `key` can be.
 */
export function keyed<K extends string, T>(key: K, schema: T) {
  return { [key]: schema } as Record<K, T>
}
