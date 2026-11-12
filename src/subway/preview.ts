import type { ArrivalsResult } from './schemas.js'

/** Routes listed at most, so a big complex still fits a launcher hint. */
export const PREVIEW_MAX_ROUTES = 6

/**
 * One line for a launcher hint: the station, then each route's next train per direction in whole
 * minutes, rounded down like station clocks. `↑` is the MTA's northbound platform (`N`), `↓` the
 * southbound one. "Bedford Av · L ↑2 ↓4 min". Pure: takes computed arrivals and `now` (epoch s).
 */
export function previewLine(result: ArrivalsResult, now: number): string {
  const byRoute = new Map<string, { N?: number; S?: number }>()
  for (const g of result.groups) {
    const next = g.arrivals[0]
    if (!next) continue
    const minutes = Math.max(0, Math.floor((next.time - now) / 60))
    const entry = byRoute.get(g.name) ?? {}
    const current = entry[g.direction]
    // Diamond express trips (6X) share their base route's name; keep the sooner train.
    if (current === undefined || minutes < current) entry[g.direction] = minutes
    byRoute.set(g.name, entry)
  }
  if (byRoute.size === 0) return `${result.stop.name} · no trains soon`
  const routes = [...byRoute.entries()].map(([name, d]) =>
    [name, d.N !== undefined ? `↑${d.N}` : '', d.S !== undefined ? `↓${d.S}` : ''].filter(Boolean).join(' ')
  )
  const shown = routes.slice(0, PREVIEW_MAX_ROUTES)
  const more = routes.length > shown.length ? ' · …' : ''
  return `${result.stop.name} · ${shown.join(' · ')} min${more}`
}
