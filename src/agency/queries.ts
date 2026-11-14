/**
 * Request schemas for the routes of `src/routes/agency.ts`. A stop is a `station` on the railroads and a `stop` on
 * the ferry, so the queries come in both forms (`STOP_QUERIES`); they all read it as `stop`, so the handler is the
 * same for both.
 */
import * as z from 'zod'
import { countParam, keyed, MAX_QUERY_LENGTH, optionalParam, previewQuery, requiredParam } from '#src/query.js'

/** What a stop is called in the API: `/lirr/arrivals?station=`, `/ferry/arrivals?stop=`. */
export type StopParam = 'station' | 'stop'

const ROUTE_DESCRIPTION = 'Only this route id (from `routes` in the station list). Case insensitive.'

export const AgencyVehiclesQuery = z.object({ route: optionalParam('route', ROUTE_DESCRIPTION) })

/** The queries that name the stop `p`. */
function stopQueries(p: StopParam) {
  const description = `A ${p} id from /<agency>/${p}s. Case insensitive.`

  const ArrivalsQuery = z
    .object({
      ...keyed(p, requiredParam(p, description)),
      limit: countParam('limit', 10, 30, 'Departures to return.'),
    })
    .transform(query => ({ stop: query[p], limit: query.limit }))

  const StopsQuery = z.object({
    q: optionalParam(
      'q',
      `Only ${p}s matching this name, best first. Without it, all of them by name.`,
      MAX_QUERY_LENGTH
    ),
    limit: countParam('limit', 10, 25, `${p}s to return with \`q\`.`),
  })

  const AlertsQuery = z
    .object({
      route: optionalParam('route', ROUTE_DESCRIPTION),
      ...keyed(p, optionalParam(p, `Only alerts naming this ${p}, or a whole route that stops there. ${description}`)),
    })
    .transform(query => ({ route: query.route, stop: query[p] }))

  const PreviewQuery = previewQuery(p, `A ${p} name: the best match is used.`, description)

  return { ArrivalsQuery, StopsQuery, AlertsQuery, PreviewQuery }
}

export const STOP_QUERIES = { station: stopQueries('station'), stop: stopQueries('stop') }
