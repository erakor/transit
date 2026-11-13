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

/**
 * The `n` items closest to a point, nearest first, each with its distance in whole meters. Ties
 * go by `id`, so the order is stable. Keeps the best n seen so far instead of sorting every item.
 */
export function nearest<T extends { lat: number; lon: number }>(
  items: Iterable<T>,
  lat: number,
  lon: number,
  n: number,
  id: (item: T) => string
): [distance: number, item: T][] {
  const best: [number, T][] = []
  if (n < 1) return best
  const before = (d: number, t: T, [bd, b]: [number, T]) => d < bd || (d === bd && id(t) < id(b))
  for (const t of items) {
    const d = Math.round(distanceMeters(lat, lon, t.lat, t.lon))
    if (best.length === n && !before(d, t, best[n - 1]!)) continue
    let i = best.length
    while (i > 0 && before(d, t, best[i - 1]!)) i--
    best.splice(i, 0, [d, t])
    if (best.length > n) best.pop()
  }
  return best
}
