/** Destinations listed at most, so a busy station still fits a launcher hint. */
const PREVIEW_MAX_DESTINATIONS = 6

/**
 * One line for a launcher hint, for systems where riders pick a train or boat by where it ends:
 * the stop, then the next departure to each destination in whole minutes, rounded down, soonest
 * first. "Grove Street · 33rd Street 2 · Newark 4 min". Pure: takes `now` (epoch s).
 */
export function destinationsLine(
  stopName: string,
  departures: Iterable<{ label: string; time: number }>,
  now: number,
  none = 'no trains soon'
): string {
  const next = new Map<string, number>()
  for (const d of departures) {
    const minutes = Math.max(0, Math.floor((d.time - now) / 60))
    // Two routes can end at the same place; keep the sooner departure.
    const current = next.get(d.label)
    if (current === undefined || minutes < current) next.set(d.label, minutes)
  }
  if (next.size === 0) return `${stopName} · ${none}`
  const parts = [...next.entries()].sort((a, b) => a[1] - b[1]).map(([label, minutes]) => `${label} ${minutes}`)
  const shown = parts.slice(0, PREVIEW_MAX_DESTINATIONS)
  return `${stopName} · ${shown.join(' · ')} min${parts.length > shown.length ? ' · …' : ''}`
}
