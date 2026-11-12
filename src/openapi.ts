/** The OpenAPI document, built from the route schemas. No function bundles this (test/bundles.test.ts). */
import * as z from 'zod'
import { AGENCIES } from '#src/agency/agencies.js'
import {
  AgencyArrival,
  AgencyVehicle,
  AgencyVehiclesQuery,
  AgencyVehiclesResponse,
  BusAlertsQuery,
  STOP_SCHEMAS,
} from '#src/agency/schemas.js'
import { TOKEN_HEADER } from '#src/auth.js'
import {
  BikeStation,
  NearbyQuery,
  NearbyResponse,
  NearbyStation,
  StationQuery,
  StationResponse,
} from '#src/citibike/schemas.js'
import {
  PathArrival,
  PathArrivalsQuery,
  PathArrivalsResponse,
  PathPreviewQuery,
  PathRouteDirectionArrivals,
  PathStationsQuery,
  PathStationsResponse,
} from '#src/path/schemas.js'
import { Alert, AlertsResult, DECIMAL, DIGITS, ErrorBody, HealthResponse, RouteDisplay } from '#src/schema.js'
import {
  AlertsQuery,
  AlertsResponse,
  Arrival,
  ArrivalsQuery,
  ArrivalsResponse,
  PreviewQuery,
  RouteDirectionArrivals,
  SearchQuery,
  SearchResponse,
  SubwayTrain,
  VehiclesQuery,
  VehiclesResponse,
} from '#src/subway/schemas.js'

interface Route {
  path: string
  /** Groups routes in the docs. */
  tag: string
  summary: string
  description: string
  query: z.ZodType
  /** A JSON schema, or `text` for the one line of the preview routes. */
  response: z.ZodType | 'text'
  /** Error statuses besides 401 and 500, with when each happens. */
  errors: Record<number, string>
  /** Answers without the token (`/health`). */
  public?: true
}

const NoQuery = z.object({})

const PREVIEW =
  'One line of `text/plain` for a launcher hint: the station, then the next trains. Errors are JSON. ' +
  '`max-age` in `Cache-Control` says how long a client may keep the line.'

/** `/lirr/...`, `/mnr/...` and `/ferry/...`: the same routes, named after what the agency calls a stop. */
function agencyRoutes(): Route[] {
  return Object.values(AGENCIES).flatMap(({ id, name, stopParam: p, vehicleWord }): Route[] => {
    const s = STOP_SCHEMAS[p]
    const tag = name
    const unknown = `Unknown \`${p}\`.`
    const unavailable = `The ${name} feed failed.`
    return [
      {
        path: `/${id}/arrivals`,
        tag,
        summary: `Next departures at a ${name} ${p}`,
        description:
          'Every route and direction in one list, soonest first, like a departure board.' +
          (AGENCIES[id]!.data.trips
            ? ' Stops the feed does not predict are timed from the last predicted stop with the schedule.'
            : ''),
        query: s.ArrivalsQuery,
        response: s.ArrivalsResponse,
        errors: { 400: `Missing \`${p}\` or bad \`limit\`.`, 404: unknown, 502: unavailable },
      },
      {
        path: `/${id}/${p}s`,
        tag,
        summary: `${name} ${p}s`,
        description: `All ${p}s by name, or those matching \`q\`, best first. Changes only with a deploy.`,
        query: s.StopsQuery,
        response: s.StopsResponse,
        errors: { 400: '`q` too long or bad `limit`.' },
      },
      {
        path: `/${id}/alerts`,
        tag,
        summary: `${name} service alerts`,
        description: `The alerts in effect now, optionally for one route or ${p}.`,
        query: s.AlertsQuery,
        response: s.AlertsResponse,
        errors: { 404: unknown, 502: `The ${name} alerts feed failed.` },
      },
      {
        path: `/${id}/vehicles`,
        tag,
        summary: `Where the ${name} ${vehicleWord} are`,
        description: 'Positions from the realtime feed, with the trip each vehicle runs when known.',
        query: AgencyVehiclesQuery,
        response: AgencyVehiclesResponse,
        errors: { 404: 'Unknown `route`.', 502: unavailable },
      },
      {
        path: `/preview/${id}`,
        tag,
        summary: `${name} departures as one line of text`,
        description: `${PREVIEW} The next departure to each destination.`,
        query: s.PreviewQuery,
        response: 'text',
        errors: {
          400: `Neither \`q\` nor \`${p}\`, or \`q\` too long.`,
          404: `Unknown \`${p}\` or no match.`,
          502: unavailable,
        },
      },
    ]
  })
}

/** Documented routes: every route but `/docs` and `/openapi.json` themselves. */
export const ROUTES: Route[] = [
  {
    path: '/subway/arrivals',
    tag: 'Subway',
    summary: 'Next trains at a subway station',
    description:
      'Next trains per route and direction. If some upstream feeds failed, the answer is still 200 with ' +
      'what was available, `unavailableFeeds`, and a shorter cache.',
    query: ArrivalsQuery,
    response: ArrivalsResponse,
    errors: { 400: 'Missing `stop` or bad `limit`.', 404: 'Unknown stop.', 502: 'Every MTA feed failed.' },
  },
  {
    path: '/stops/search',
    tag: 'Subway',
    summary: 'Find subway stations by name',
    description: 'Station complexes matching a name, best first. Changes only with a deploy.',
    query: SearchQuery,
    response: SearchResponse,
    errors: { 400: 'Missing or too long `q`, or bad `limit`.' },
  },
  {
    path: '/subway/alerts',
    tag: 'Subway',
    summary: 'Subway service alerts',
    description: 'The alerts in effect now, optionally for one route or station.',
    query: AlertsQuery,
    response: AlertsResponse,
    errors: { 404: 'Unknown route or stop.', 502: 'The alerts feed failed.' },
  },
  {
    path: '/subway/vehicles',
    tag: 'Subway',
    summary: "Where a subway route's trains are",
    description: 'The stop each train of the route is at or heading to. The subway feeds carry no coordinates.',
    query: VehiclesQuery,
    response: VehiclesResponse,
    errors: { 400: 'Missing `route`.', 404: 'Unknown route.', 502: "The route's feed failed." },
  },
  {
    path: '/preview/subway',
    tag: 'Subway',
    summary: 'Subway arrivals as one line of text',
    description: `${PREVIEW} The next train per route and direction.`,
    query: PreviewQuery,
    response: 'text',
    errors: {
      400: 'Neither `q` nor `stop`, or `q` too long.',
      404: 'Unknown stop or no match.',
      502: 'Every MTA feed failed.',
    },
  },
  {
    path: '/path/arrivals',
    tag: 'PATH',
    summary: 'Next trains at a PATH station',
    description: 'Next trains per route and direction.',
    query: PathArrivalsQuery,
    response: PathArrivalsResponse,
    errors: { 400: 'Missing `station` or bad `limit`.', 404: 'Unknown station.', 502: 'The PATH feed failed.' },
  },
  {
    path: '/path/stations',
    tag: 'PATH',
    summary: 'PATH stations',
    description: 'The 13 stations with the routes serving them.',
    query: PathStationsQuery,
    response: PathStationsResponse,
    errors: {},
  },
  {
    path: '/preview/path',
    tag: 'PATH',
    summary: 'PATH arrivals as one line of text',
    description: `${PREVIEW} The next train to each destination.`,
    query: PathPreviewQuery,
    response: 'text',
    errors: {
      400: 'Neither `q` nor `station`, or `q` too long.',
      404: 'Unknown station or no match.',
      502: 'The PATH feed failed.',
    },
  },
  ...agencyRoutes(),
  {
    path: '/bus/alerts',
    tag: 'Bus',
    summary: 'Bus service alerts',
    description: 'The alerts in effect now, optionally for one route. Routes show under their id.',
    query: BusAlertsQuery,
    response: AlertsResult,
    errors: { 502: 'The alerts feed failed.' },
  },
  {
    path: '/citibike/station',
    tag: 'Citi Bike',
    summary: 'Bikes and docks at a Citi Bike station',
    description: 'Classic bikes, e-bikes and free docks at one station.',
    query: StationQuery,
    response: StationResponse,
    errors: { 400: 'Missing `id`.', 404: 'Unknown station.', 502: 'The Citi Bike feeds failed.' },
  },
  {
    path: '/citibike/nearby',
    tag: 'Citi Bike',
    summary: 'Citi Bike stations near a point',
    description: 'The closest stations on the street, nearest first, with their bikes and docks.',
    query: NearbyQuery,
    response: NearbyResponse,
    errors: { 400: 'Missing or bad `lat` or `lon`, or bad `n`.', 502: 'The Citi Bike feeds failed.' },
  },
  {
    path: '/health',
    tag: 'Service',
    summary: 'Service health',
    description: 'Which static subway schedule is deployed. No token, never cached.',
    query: NoQuery,
    response: HealthResponse,
    errors: {},
    public: true,
  },
]

/** Schemas shown under their own name, and referenced from where they're used. */
const NAMED: Record<string, z.ZodType> = {
  ArrivalsResponse,
  RouteDirectionArrivals,
  Arrival,
  StopSearchResponse: SearchResponse,
  SubwayAlertsResponse: AlertsResponse,
  SubwayVehiclesResponse: VehiclesResponse,
  SubwayTrain,
  PathArrivalsResponse,
  PathRouteDirectionArrivals,
  PathArrival,
  PathStationsResponse,
  RailArrivalsResponse: STOP_SCHEMAS.station.ArrivalsResponse,
  FerryArrivalsResponse: STOP_SCHEMAS.stop.ArrivalsResponse,
  AgencyArrival,
  RailStationsResponse: STOP_SCHEMAS.station.StopsResponse,
  FerryStopsResponse: STOP_SCHEMAS.stop.StopsResponse,
  RailAlertsResponse: STOP_SCHEMAS.station.AlertsResponse,
  FerryAlertsResponse: STOP_SCHEMAS.stop.AlertsResponse,
  AgencyVehiclesResponse,
  AgencyVehicle,
  AlertsResponse: AlertsResult,
  Alert,
  CitibikeStationResponse: StationResponse,
  CitibikeNearbyResponse: NearbyResponse,
  BikeStation,
  NearbyStation,
  HealthResponse,
  Route: RouteDisplay,
  Error: ErrorBody,
}

/** Drops the keys that only make sense in a standalone JSON Schema document. */
function embedded(schema: object): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>
  return rest
}

/**
 * Query parameters arrive as text, and their schemas check the text, but count and coordinate
 * parameters are numbers to clients (countParam and coordinateParam in src/schema.ts).
 */
function asNumber(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.pattern === DIGITS.source) {
    const { pattern: _pattern, ...rest } = schema
    return { ...rest, type: 'integer', minimum: 1, default: Number(schema.default) }
  }
  if (schema.pattern === DECIMAL.source) {
    const { pattern: _pattern, minLength: _minLength, ...rest } = schema
    return { ...rest, type: 'number' }
  }
  return schema
}

export function buildOpenApi(version: string) {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(NAMED)) registry.add(schema, { id })
  const { schemas } = z.toJSONSchema(registry, { uri: id => `#/components/schemas/${id}` })
  const ref = (schema: z.ZodType) => {
    const id = registry.get(schema)?.id
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
        const { description, ...schema } = property as Record<string, unknown>
        return {
          name,
          in: 'query',
          required: query.required?.includes(name) ?? false,
          description,
          schema: asNumber(schema),
        }
      })
      const ok =
        route.response === 'text'
          ? { description: 'OK', content: { 'text/plain': { schema: { type: 'string' } } } }
          : json(ref(route.response), 'OK')
      const responses = {
        200: ok,
        ...(route.public ? {} : { 401: error('Missing or wrong token.'), 500: error('Unexpected failure.') }),
        ...Object.fromEntries(Object.entries(route.errors).map(([status, why]) => [status, error(why)])),
      }
      const { path, tag, summary, description } = route
      // `/subway/arrivals` -> `subwayArrivals`: names the operation in generated clients.
      const operationId = path.slice(1).replace(/[/-](\w)/g, (_, c: string) => c.toUpperCase())
      const security = route.public ? { security: [] } : {}
      return [path, { get: { operationId, tags: [tag], summary, description, ...security, parameters, responses } }]
    })
  )

  return {
    openapi: '3.1.1',
    info: {
      title: 'transit',
      version,
      description:
        'Normalized JSON over the NYC transit feeds: the MTA subway, LIRR, Metro-North and buses, PATH, NYC Ferry ' +
        'and Citi Bike. Times are epoch seconds. Every route but `/health` needs the token.',
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
