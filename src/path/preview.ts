import { destinationsLine } from '#src/preview.js'
import type { PathArrivalsResponse } from './schemas.js'

/**
 * One line for a launcher hint: the station, then the next train to each destination (see
 * `destinationsLine`). PATH riders pick a train by where it ends, so the line names
 * destinations rather than routes. Pure: takes computed arrivals and `now` (epoch s).
 */
export function pathPreviewLine(result: PathArrivalsResponse, now: number): string {
  const trains = result.groups.flatMap(g => g.arrivals.map(a => ({ label: a.headsign || g.name, time: a.time })))
  return destinationsLine(result.station.name, trains, now)
}
