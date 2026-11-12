import type { BusData } from '#src/bus/types.js'
import { DEFAULT_COLOR, hex, type GtfsFiles } from './build.js'
import { parseCsvObjects } from './csv.js'

/**
 * Turns the MTA's bus GTFS feeds (one per borough, and MTA Bus Company's) into {@link BusData}.
 * The borough feeds repeat the same routes, so a route id seen twice keeps its first row.
 * Riders know a route by its short name (`M15-SBS`, `Bx12`), so that is its name. Deterministic:
 * keys are sorted, so the same feeds give a byte-identical file.
 */
export function buildBusData(feeds: GtfsFiles[]): BusData {
  const routes: BusData['routes'] = {}
  const versions = new Set<string>()
  for (const files of feeds) {
    if (files['routes.txt'] === undefined) throw new Error('GTFS is missing routes.txt')
    for (const r of parseCsvObjects(files['routes.txt'])) {
      if (!r.route_id || routes[r.route_id]) continue
      routes[r.route_id] = {
        id: r.route_id,
        name: r.route_short_name || r.route_id,
        color: hex(r.route_color, DEFAULT_COLOR),
        textColor: hex(r.route_text_color, 'FFFFFF'),
      }
    }
    const version = files['feed_info.txt'] ? parseCsvObjects(files['feed_info.txt'])[0]?.feed_version : undefined
    if (version) versions.add(version)
  }
  if (Object.keys(routes).length === 0) throw new Error('bus GTFS has no routes')
  const sorted = Object.fromEntries(
    Object.keys(routes)
      .sort()
      .map(id => [id, routes[id]!])
  )
  return { feedVersion: [...versions].sort().join('+'), routes: sorted }
}
