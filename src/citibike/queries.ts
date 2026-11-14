/** Request schemas for the Citi Bike routes. */
import * as z from 'zod'
import { coordinateParam, countParam, requiredParam } from '#src/query.js'

export const StationQuery = z.object({
  id: requiredParam('id', 'A station id from /citibike/nearby. Exact: ids are opaque strings.'),
})

export const NearbyQuery = z.object({
  lat: coordinateParam('lat', 90, 'Latitude of the point, in decimal degrees.'),
  lon: coordinateParam('lon', 180, 'Longitude of the point, in decimal degrees.'),
  n: countParam('n', 5, 25, 'Stations to return.'),
})
