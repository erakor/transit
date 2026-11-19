/** Request schemas for the subway routes (`/subway/...`, `/stops/search` and `/preview/subway`). */
import * as z from 'zod'
import {
  countParam,
  MAX_QUERY_LENGTH,
  optionalParam,
  previewQuery,
  requiredParam,
} from '#src/query.js'

const STOP_DESCRIPTION =
  'A station id from /stops/search (stop ids joined with `+`, such as `127+725+902+A27+R16`), ' +
  'a GTFS stop id (`127`) or one platform (`127N`). Case insensitive.'

export const ArrivalsQuery = z.object({
  stop: requiredParam('stop', STOP_DESCRIPTION),
  limit: countParam('limit', 3, 10, 'Trains per route and direction.'),
})

export const SearchQuery = z.object({
  q: requiredParam('q', 'Station name, or part of one (`times sq`, `bedford`).', MAX_QUERY_LENGTH),
  limit: countParam('limit', 10, 25, 'Stations to return.'),
})

export const AlertsQuery = z.object({
  route: optionalParam('route', 'Only alerts about this route id (`A`, `6X`). Case insensitive.'),
  stop: optionalParam(
    'stop',
    `Only alerts naming one of this station's stops, or a whole route that stops there. ${STOP_DESCRIPTION}`,
  ),
})

export const VehiclesQuery = z.object({
  route: requiredParam('route', 'A route id (`A`, `6X`). Case insensitive.'),
})

export const PreviewQuery = previewQuery(
  'stop',
  'A station name: the best /stops/search match is used.',
  STOP_DESCRIPTION,
)
