/** MTA subway GTFS-realtime feeds (no API key needed) and the routes each one carries. */
export const FEEDS: Record<string, readonly string[]> = {
  gtfs: ["1", "2", "3", "4", "5", "6", "6X", "7", "7X", "GS"],
  "gtfs-ace": ["A", "C", "E", "H"],
  "gtfs-bdfm": ["B", "D", "F", "FX", "M", "FS"],
  "gtfs-g": ["G"],
  "gtfs-jz": ["J", "Z"],
  "gtfs-nqrw": ["N", "Q", "R", "W"],
  "gtfs-l": ["L"],
  "gtfs-si": ["SI", "SS"],
};

const FEED_OF_ROUTE = new Map<string, string>();
for (const [feed, routes] of Object.entries(FEEDS)) for (const r of routes) FEED_OF_ROUTE.set(r, feed);

/** The feeds that carry any of `routes`, in FEEDS order. Unknown routes are ignored. */
export function feedsForRoutes(routes: Iterable<string>): string[] {
  const wanted = new Set<string>();
  for (const r of routes) {
    const f = FEED_OF_ROUTE.get(r);
    if (f) wanted.add(f);
  }
  return Object.keys(FEEDS).filter((f) => wanted.has(f));
}
