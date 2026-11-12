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
 * A required query parameter, trimmed. Missing, empty and blank all answer "<name> is required".
 * The custom `error` replaces zod's default messages ("Invalid input: expected string, received
 * undefined") with the one this API has always answered.
 */
export function requiredParam(name: string, description: string) {
  const error = `${name} is required`;
  return z.string({ error }).trim().min(1, { error }).meta({ description });
}

/**
 * An optional positive integer query parameter: `fallback` when absent, clamped to `max` when
 * larger (a too-large value is not an error, so clients can ask for "as many as you allow").
 *
 * Query parameters are strings, so the schema checks the text first: digits only, like
 * `intParam()` in `http.ts`, which the routes without schemas still use. (`z.coerce.number()`
 * would be shorter, but `Number()` also reads "1e1", "0x10" and " 5".) The transforms then turn
 * it into a number; the JSON Schema for requests shows the text rule, which is what clients send.
 *
 * `.prefault()` rather than `.default()`: a default is an output value and skips the schema, a
 * prefault is fed in as input and goes through it. The result is the same here, but zod leaves
 * a default that follows a transform out of the JSON Schema it generates for requests.
 */
export function countParam(name: string, fallback: number, max: number, description: string) {
  const error = `${name} must be a positive integer`;
  return z
    .string()
    .regex(/^\d+$/, { error })
    // Clamp before the int check: z.int() rejects values past 2^53, which intParam lowers to max.
    .transform((s) => Math.min(Number(s), max))
    .pipe(z.int().min(1, { error }))
    .prefault(String(fallback))
    .meta({ description: `${description} Default ${fallback}, at most ${max} (larger values are lowered to ${max}).` });
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
  url: URL,
): { ok: true; query: z.output<S> } | { ok: false; response: Response } {
  // No prototype, so names like `constructor` are ordinary keys.
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) if (!(key in raw)) raw[key] = value;
  for (const key in raw) if (raw[key] === "") delete raw[key];
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, query: parsed.data };
  return { ok: false, response: errorResponse(400, parsed.error.issues[0]?.message ?? "invalid query") };
}
