/**
 * Building blocks for request and response schemas (zod), shared by every provider.
 *
 * A schema is a value that still exists at runtime, unlike a TypeScript interface, so the same
 * definition gives us three things: a type (`z.infer`), a check (`schema.safeParse`), and later a
 * JSON Schema for the API docs (`z.toJSONSchema`). Descriptions go in `.meta()` rather than in
 * comments so they end up in those docs too.
 */
import * as z from "zod";
import { errorResponse } from "./http.js";

/** Times in responses: whole seconds since the Unix epoch. */
export const EpochSeconds = z.int().nonnegative().meta({ description: "Epoch seconds." });

/** Route colors: `#` and six uppercase hex digits, as the static data stores them. */
export const HexColor = z.string().regex(/^#[0-9A-F]{6}$/);

/** The body of every 4xx and 5xx answer. */
export const ErrorBody = z.strictObject({ error: z.string() });

/**
 * An optional positive integer query parameter: `fallback` when absent, clamped to `max` when
 * larger (a too-large value is not an error, so clients can ask for "as many as you allow").
 *
 * Query parameters are always strings; `z.coerce.number()` turns "5" into 5 before the number
 * checks run. The custom `error` replaces zod's default messages ("Invalid input: expected
 * number, received NaN") with the one this API has always answered.
 *
 * `.prefault()` rather than `.default()`: a default is an output value and skips the schema, a
 * prefault is fed in as input and goes through it. The result is the same here, but zod leaves
 * a default that follows a transform out of the JSON Schema it generates for requests.
 */
export function countParam(name: string, fallback: number, max: number) {
  const error = `${name} must be a positive integer`;
  return z.coerce
    .number({ error })
    .int({ error })
    .min(1, { error })
    .transform((n) => Math.min(n, max))
    .prefault(fallback)
    .meta({ description: `Default ${fallback}, at most ${max} (larger values are lowered to ${max}).` });
}

/**
 * Validates a request's query string against `schema`. Returns the parsed, typed values, or a
 * ready 400 response carrying the first problem's message.
 *
 * Empty parameters (`?limit=`) count as absent, so they get the default or the "is required"
 * error. A repeated parameter keeps its first value, like `URLSearchParams.get()`. Parameters the
 * schema doesn't name are ignored (`z.object` strips unknown keys).
 */
export function parseQuery<S extends z.ZodType>(
  schema: S,
  url: URL,
): { ok: true; query: z.output<S> } | { ok: false; response: Response } {
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (value !== "" && !(key in raw)) raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, query: parsed.data };
  return { ok: false, response: errorResponse(400, parsed.error.issues[0]?.message ?? "invalid query") };
}
