/**
 * The OpenAPI document for the routes that have schemas, built from those schemas. Only
 * `scripts/build-openapi.ts` and the tests import this: no function bundles it.
 */
import * as z from 'zod'
import { TOKEN_HEADER } from '#src/auth.js'
import { ErrorBody } from '#src/schema.js'
import { Arrival, ArrivalsQuery, ArrivalsResponse, RouteDirectionArrivals } from '#src/subway/schemas.js'

interface Route {
  path: string
  /** Names the operation in generated clients. */
  operationId: string
  summary: string
  description: string
  query: z.ZodObject
  response: z.ZodType
  /** Error statuses besides 401, with when each happens. */
  errors: Record<number, string>
}

/** Documented routes. A route gets an entry when it gets schemas (AGENTS.md). */
export const ROUTES: Route[] = [
  {
    path: '/subway/arrivals',
    operationId: 'subwayArrivals',
    summary: 'Next trains at a subway station',
    description:
      'Next trains per route and direction. If some upstream feeds failed, the answer is still 200 with ' +
      'what was available, `unavailableFeeds`, and a 5 s cache instead of 20 s.',
    query: ArrivalsQuery,
    response: ArrivalsResponse,
    errors: { 400: 'Missing `stop` or bad `limit`.', 404: 'Unknown stop.', 502: 'Every MTA feed failed.' },
  },
]

/** Schemas shown under their own name, and referenced from where they're used. */
const NAMED: Record<string, z.ZodType> = { ArrivalsResponse, RouteDirectionArrivals, Arrival, Error: ErrorBody }

/** Drops the keys that only make sense in a standalone JSON Schema document. */
function embedded(schema: object): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>
  return rest
}

export function buildOpenApi(version: string) {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(NAMED)) registry.add(schema, { id })
  const { schemas } = z.toJSONSchema(registry, { uri: id => `#/components/schemas/${id}` })
  const ref = (schema: z.ZodType) => {
    const id = Object.keys(NAMED).find(id => NAMED[id] === schema)
    if (!id) throw new Error('response schemas must be listed in NAMED')
    return { $ref: `#/components/schemas/${id}` }
  }
  const json = (schema: object, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  })
  const error = (description: string) => json(ref(ErrorBody), description)

  const paths = Object.fromEntries(
    ROUTES.map(route => {
      const query = z.toJSONSchema(route.query, { io: 'input' })
      const parameters = Object.entries(query.properties ?? {}).map(([name, property]) => {
        const { description, ...schema } = embedded(property as object)
        return { name, in: 'query', required: query.required?.includes(name) ?? false, description, schema }
      })
      const responses = {
        200: json(ref(route.response), 'OK'),
        401: error('Missing or wrong token.'),
        ...Object.fromEntries(Object.entries(route.errors).map(([status, why]) => [status, error(why)])),
      }
      const { path, operationId, summary, description } = route
      return [path, { get: { operationId, summary, description, parameters, responses } }]
    })
  )

  return {
    openapi: '3.1.1',
    info: {
      title: 'transit',
      version,
      description:
        'Normalized JSON over the NYC transit feeds. Times are epoch seconds. This lists the routes that have ' +
        'schemas so far; the README documents every route.',
    },
    servers: [{ url: '/' }],
    security: [{ token: [] }],
    paths,
    components: {
      securitySchemes: { token: { type: 'apiKey', in: 'header', name: TOKEN_HEADER } },
      schemas: Object.fromEntries(Object.entries(schemas).map(([id, schema]) => [id, embedded(schema)])),
    },
  }
}
