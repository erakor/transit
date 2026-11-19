/** Request schemas for the PATH routes. */
import * as z from 'zod'
import { countParam, previewQuery, requiredParam } from '#src/query.js'

const STATION_DESCRIPTION =
  'A station id from /path/stations (`WTC`, `HOB`, `09S`). Case insensitive.'

export const PathArrivalsQuery = z.object({
  station: requiredParam('station', STATION_DESCRIPTION),
  limit: countParam('limit', 3, 10, 'Trains per route and direction.'),
})

export const PathPreviewQuery = previewQuery(
  'station',
  'A station name (`hoboken`, `wtc`, `journal sq`): the best match is used.',
  STATION_DESCRIPTION,
)
