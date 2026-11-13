/**
 * Request and response schemas for the bus routes of `src/routes/bus.ts` (`/bus/arrivals`,
 * `/preview/bus`, `/bus/alerts`, `/bus/vehicles`, `/bus/nearby`), and the types inferred from them.
 */
import * as z from 'zod'
import {
  coordinateParam,
  countParam,
  EpochSeconds,
  FeedUpdatedAt,
  Latitude,
  Longitude,
  optionalParam,
  requiredParam,
  RouteDisplay,
  RouteFields,
  StopRef,
} from '#src/schema.js'

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

export const BusArrival = z.strictObject({
  time: EpochSeconds.nullable().meta({
    description: 'Predicted arrival. Null when Bus Time has no prediction, usually for a bus still at its terminal.',
  }),
  ...RouteFields,
  route: RouteFields.route.meta({ description: 'GTFS route id (`M15+`), as in `/bus/alerts`.' }),
  headsign: z.string().meta({ description: 'Where the trip ends, as the bus shows it.' }),
  distance: z.string().meta({
    description: "Bus Time's distance for riders: `approaching`, `2 stops away`, `1.3 miles away`. Empty when unknown.",
  }),
  stopsAway: z.int().nonnegative().nullable(),
  meters: z.int().nonnegative().nullable().meta({ description: 'Distance along the route.' }),
  atTerminal: z.boolean().meta({
    description: 'The bus is waiting to start its trip or still finishing its previous one, so its time is less sure.',
  }),
  cancelled: z.boolean().meta({
    description: "The trip is cancelled: listed at its scheduled time (or without one) so riders know it won't come.",
  }),
  vehicle: z.string().meta({ description: 'The bus number; empty when unknown.' }),
  tripId: z.string(),
})

export const BusArrivalsResponse = z.strictObject({
  stop: z.strictObject({
    id: z.string(),
    name: z.string().nullable().meta({ description: 'From Bus Time; null when no bus is on its way to tell it.' }),
  }),
  updatedAt: FeedUpdatedAt.meta({ description: "Bus Time's response timestamp." }),
  arrivals: z.array(BusArrival).meta({
    description: 'Every route in one list: soonest first, then buses without a prediction, nearest first.',
  }),
})

export const BusAlertsQuery = z.object({
  route: optionalParam('route', 'Only alerts about this bus route id (`M15`, `B44+`). Case insensitive.'),
})

const ROUTE_ID_DESCRIPTION =
  'A bus route id (`M15`, `Q06`, `BX12`). Select Bus Service routes end in `+` (`M15+`, sent as `M15%2B`) or can be written `M15-SBS`. Case insensitive.'

export const BusVehiclesQuery = z.object({ route: requiredParam('route', ROUTE_ID_DESCRIPTION) })

export const BusVehicle = z.strictObject({
  id: z.string().meta({ description: 'The bus number.' }),
  headsign: z.string().meta({ description: 'Where its trip ends, as the bus shows it.' }),
  lat: Latitude,
  lon: Longitude,
  heading: z.int().min(0).max(359).nullable().meta({
    description: 'Compass heading in degrees, clockwise from north; null when unknown.',
  }),
  stop: StopRef.nullable().meta({ description: 'Its next stop: the stop code and name. Null when unknown.' }),
  distance: z
    .string()
    .meta({ description: 'How far from that stop, for riders: `at stop`, `approaching`, `1 stop away`.' }),
  stopsAway: z.int().nonnegative().nullable(),
  atTerminal: z.boolean().meta({
    description: 'Waiting to start its trip or still finishing its previous one.',
  }),
  time: EpochSeconds.nullable().meta({ description: 'When the position was recorded.' }),
  tripId: z.string(),
})

export const BusVehiclesResponse = z.strictObject({
  route: RouteDisplay,
  updatedAt: FeedUpdatedAt.meta({ description: "Bus Time's response timestamp." }),
  vehicles: z
    .array(BusVehicle)
    .meta({ description: 'Every bus on the route, both directions, by headsign then bus number.' }),
})

export const BusNearbyQuery = z.object({
  lat: coordinateParam('lat', 90, 'Latitude of the point, in decimal degrees.'),
  lon: coordinateParam('lon', 180, 'Longitude of the point, in decimal degrees.'),
  limit: countParam('limit', 10, 25, 'Stops to return.'),
})

export const NearbyBusStop = z.strictObject({
  id: z.string().meta({ description: 'The six-digit code on the stop sign, which `/bus/arrivals` takes.' }),
  name: z.string().meta({ description: 'As Bus Time names it (`1 AV/E 14 ST`).' }),
  direction: z.string().meta({
    description: 'The compass direction buses there travel (`N`, `NE`, ... `NW`); empty when unknown.',
  }),
  lat: Latitude,
  lon: Longitude,
  distance: z.int().nonnegative().meta({ description: 'Meters from the point, in a straight line.' }),
  routes: z.array(RouteDisplay).meta({ description: 'The routes that stop there.' }),
})

export const BusNearbyResponse = z.strictObject({
  stops: z
    .array(NearbyBusStop)
    .meta({ description: 'Stops within 500 m of the point, nearest first; empty when there are none.' }),
})

export type BusArrival = z.infer<typeof BusArrival>
export type BusVehicle = z.infer<typeof BusVehicle>
export type NearbyBusStop = z.infer<typeof NearbyBusStop>
export type BusArrivalsResponse = z.infer<typeof BusArrivalsResponse>
export type BusVehiclesResponse = z.infer<typeof BusVehiclesResponse>
export type BusNearbyResponse = z.infer<typeof BusNearbyResponse>
