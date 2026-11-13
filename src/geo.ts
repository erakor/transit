/** Geometry shared by the providers that answer "near a point" (Citi Bike, buses). */

const EARTH_RADIUS_M = 6_371_000
const rad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}
