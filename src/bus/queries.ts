/** Request schemas for the bus routes of `src/routes/bus.ts`. */
import * as z from 'zod'
import { coordinateParam, countParam, optionalParam, requiredParam } from '#src/query.js'

const STOP_DESCRIPTION =
  'The six-digit stop code on the bus stop sign (`308209`), as Bus Time knows it. Stable: store it as a favorite.'

/** Six digits; a leading `MTA_`, as Bus Time writes stop refs, is accepted and dropped. */
const stopCode = requiredParam('stop', STOP_DESCRIPTION)
  .transform(s => s.replace(/^MTA_/i, ''))
  .pipe(z.string().regex(/^\d{6}$/, { error: 'stop must be a six-digit bus stop code' }))

export const BusArrivalsQuery = z.object({
  stop: stopCode,
  limit: countParam('limit', 10, 30, 'Buses to return.'),
})

export const BusPreviewQuery = z.object({ stop: stopCode })

const ROUTE_ID_DESCRIPTION =
  'A bus route id (`M15`, `Q06`, `BX12`). Select Bus Service routes end in `+` (`M15+`, sent as `M15%2B`) or can be written `M15-SBS`. Case insensitive.'

export const BusAlertsQuery = z.object({
  route: optionalParam('route', `Only alerts about this route. ${ROUTE_ID_DESCRIPTION}`),
})

export const BusVehiclesQuery = z.object({ route: requiredParam('route', ROUTE_ID_DESCRIPTION) })

export const BusNearbyQuery = z.object({
  lat: coordinateParam('lat', 90, 'Latitude of the point, in decimal degrees.'),
  lon: coordinateParam('lon', 180, 'Longitude of the point, in decimal degrees.'),
  limit: countParam('limit', 10, 25, 'Stops to return.'),
})
