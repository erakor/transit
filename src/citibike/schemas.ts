/** Request and response schemas for the Citi Bike routes, and the types inferred from them. */
import * as z from 'zod'
import { coordinateParam, countParam, EpochSeconds, Latitude, Longitude, requiredParam } from '#src/schema.js'

const Count = z.int().nonnegative()

export const StationQuery = z.object({
  id: requiredParam('id', 'A station id from /citibike/nearby. Exact: ids are opaque strings.'),
})

export const NearbyQuery = z.object({
  lat: coordinateParam('lat', 90, 'Latitude of the point, in decimal degrees.'),
  lon: coordinateParam('lon', 180, 'Longitude of the point, in decimal degrees.'),
  n: countParam('n', 5, 25, 'Stations to return.'),
})

export const BikeStation = z.strictObject({
  id: z.string().meta({ description: 'Opaque (a UUID or a long digit string). Stable: store it as a favorite.' }),
  name: z.string(),
  lat: Latitude,
  lon: Longitude,
  capacity: Count.meta({ description: 'Docks at the station, in any state.' }),
  bikes: Count.meta({ description: 'Classic (pedal) bikes ready to rent.' }),
  ebikes: Count.meta({ description: 'E-bikes ready to rent.' }),
  docks: Count.meta({ description: 'Free docks.' }),
  renting: z.boolean().meta({ description: "False when the station isn't renting bikes." }),
  returning: z.boolean().meta({ description: "False when the station isn't accepting returns." }),
  reportedAt: EpochSeconds.optional().meta({ description: 'When the station last reported. Absent if it never did.' }),
})

export const NearbyStation = BikeStation.extend({
  distance: Count.meta({ description: 'Meters from the requested point, as the crow flies.' }),
})

const UpdatedAt = EpochSeconds.meta({ description: "`station_status`'s timestamp." })

export const StationResponse = z.strictObject({ updatedAt: UpdatedAt, station: BikeStation })

export const NearbyResponse = z.strictObject({
  lat: Latitude,
  lon: Longitude,
  updatedAt: UpdatedAt,
  stations: z.array(NearbyStation).meta({ description: 'Nearest first. Only stations on the street.' }),
})

export type BikeStation = z.infer<typeof BikeStation>
export type NearbyStation = z.infer<typeof NearbyStation>
export type StationResponse = z.infer<typeof StationResponse>
export type NearbyResponse = z.infer<typeof NearbyResponse>
