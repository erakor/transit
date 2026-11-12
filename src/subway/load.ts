import type { ResolvedStop, StationIndex } from '#src/stops/stations.js'
import { fetchFeed, type Fetcher } from '#src/gtfsrt.js'
import { computeArrivals } from './arrivals.js'
import { feedsForRoutes } from './feeds.js'
import type { ArrivalsResult } from './schemas.js'

/**
 * Fetches the feeds serving `stop` and computes its arrivals. Shared by the arrivals and preview
 * routes; kept out of the route module so the preview function doesn't load zod.
 * `failed` names the feeds that didn't answer; undefined when every feed failed.
 */
export async function loadArrivals(
  stop: ResolvedStop,
  idx: StationIndex,
  { fetcher, nowMs, limit }: { fetcher?: Fetcher; nowMs: number; limit: number }
): Promise<{ result: ArrivalsResult; failed: string[] } | undefined> {
  const names = feedsForRoutes(stop.routes)
  const settled = await Promise.allSettled(names.map(f => fetchFeed(f, { fetcher, now: nowMs })))
  const feeds = settled.flatMap(s => (s.status === 'fulfilled' ? [s.value] : []))
  const failed = names.filter((_, i) => settled[i]!.status === 'rejected')
  for (const [i, s] of settled.entries()) {
    if (s.status === 'rejected') console.error(`feed ${names[i]} failed:`, s.reason)
  }
  if (names.length > 0 && feeds.length === 0) return undefined
  return { result: computeArrivals(stop, feeds, idx, { now: Math.floor(nowMs / 1000), limit }), failed }
}
