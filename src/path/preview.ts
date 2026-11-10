import type { PathArrivalsResult } from "./arrivals.js";

/**
 * One line for a launcher hint: the station, then the next train to each destination in whole
 * minutes, rounded down, soonest first. PATH riders pick a train by where it ends, so the line
 * names destinations rather than routes. "Grove Street · 33rd Street 2 · Newark 4 min".
 * Pure: takes computed arrivals and `now` (epoch s).
 */
export function pathPreviewLine(result: PathArrivalsResult, now: number): string {
  const byHeadsign = new Map<string, number>();
  for (const g of result.groups) {
    for (const a of g.arrivals) {
      const minutes = Math.max(0, Math.floor((a.time - now) / 60));
      const label = a.headsign || g.name;
      // Two routes can end at the same place (both World Trade Center lines); keep the sooner train.
      const current = byHeadsign.get(label);
      if (current === undefined || minutes < current) byHeadsign.set(label, minutes);
    }
  }
  if (byHeadsign.size === 0) return `${result.station.name} · no trains soon`;
  const parts = [...byHeadsign.entries()].sort((a, b) => a[1] - b[1]).map(([label, minutes]) => `${label} ${minutes}`);
  return `${result.station.name} · ${parts.join(" · ")} min`;
}
