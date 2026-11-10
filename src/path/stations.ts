import type { RouteDisplay } from "../gtfsrt.js";
import { rankByName, tokenize } from "../stops/search.js";

export type PathRoute = RouteDisplay;

/**
 * PATH lines in the order PATH lists them. The realtime feed has no route id, only a line color
 * (two for the night and weekend line that combines two daytime ones), so `feedColors` is how a
 * train finds its route: the feed's `lineColor` values, uppercased, sorted and joined with ",".
 */
const ROUTES: (PathRoute & { feedColors: string })[] = [
  { id: "NWK-WTC", name: "Newark - World Trade Center", color: "#D93A30", textColor: "#FFFFFF", feedColors: "D93A30" },
  { id: "HOB-WTC", name: "Hoboken - World Trade Center", color: "#65C100", textColor: "#FFFFFF", feedColors: "65C100" },
  { id: "JSQ-33", name: "Journal Square - 33rd Street", color: "#FF9900", textColor: "#FFFFFF", feedColors: "FF9900" },
  { id: "HOB-33", name: "Hoboken - 33rd Street", color: "#4D92FB", textColor: "#FFFFFF", feedColors: "4D92FB" },
  { id: "JSQ-33-HOB", name: "Journal Square - 33rd Street (via Hoboken)", color: "#FF9900", textColor: "#FFFFFF", feedColors: "4D92FB,FF9900" },
];

const ROUTE_BY_COLORS = new Map(ROUTES.map(({ feedColors, ...route }): [string, PathRoute] => [feedColors, route]));
export const PATH_ROUTES: readonly PathRoute[] = [...ROUTE_BY_COLORS.values()];
const ROUTE_BY_ID = new Map(PATH_ROUTES.map((r) => [r.id, r]));

/** The feed's `lineColor` ("4d92fb,ff9900") as a lookup key ("4D92FB,FF9900"). */
export function colorsKey(lineColor: string): string {
  return lineColor
    .toUpperCase()
    .split(",")
    .map((c) => c.trim().replace(/^#/, ""))
    .filter(Boolean)
    .sort()
    .join(",");
}

/** The route running under a `colorsKey`, or undefined for a color PATH has not used before. */
export function routeForColors(key: string): PathRoute | undefined {
  return ROUTE_BY_COLORS.get(key);
}

/** Position of a route id in PATH's order; unknown routes go last. */
export function routeOrder(id: string): number {
  const i = PATH_ROUTES.findIndex((r) => r.id === id);
  return i === -1 ? PATH_ROUTES.length : i;
}

export interface PathStation {
  /** The realtime feed's station code, which clients store as favorites: keep stable. */
  id: string;
  name: string;
  /** Route ids with scheduled service, in PATH's order. */
  routes: string[];
}

const UPTOWN = ["JSQ-33", "HOB-33", "JSQ-33-HOB"];

/** The 13 PATH stations, west to east along the Newark line, then Hoboken, then up 6th Avenue. */
export const PATH_STATIONS: readonly PathStation[] = [
  { id: "NWK", name: "Newark", routes: ["NWK-WTC"] },
  { id: "HAR", name: "Harrison", routes: ["NWK-WTC"] },
  { id: "JSQ", name: "Journal Square", routes: ["NWK-WTC", "JSQ-33", "JSQ-33-HOB"] },
  { id: "GRV", name: "Grove Street", routes: ["NWK-WTC", "JSQ-33", "JSQ-33-HOB"] },
  { id: "EXP", name: "Exchange Place", routes: ["NWK-WTC", "HOB-WTC"] },
  { id: "WTC", name: "World Trade Center", routes: ["NWK-WTC", "HOB-WTC"] },
  { id: "NEW", name: "Newport", routes: ["HOB-WTC", "JSQ-33", "JSQ-33-HOB"] },
  { id: "HOB", name: "Hoboken", routes: ["HOB-WTC", "HOB-33", "JSQ-33-HOB"] },
  { id: "CHR", name: "Christopher Street", routes: UPTOWN },
  { id: "09S", name: "9th Street", routes: UPTOWN },
  { id: "14S", name: "14th Street", routes: UPTOWN },
  { id: "23S", name: "23rd Street", routes: UPTOWN },
  { id: "33S", name: "33rd Street", routes: UPTOWN },
];

/** Other things riders call a station. Its id always matches too. */
const ALIASES: Record<string, string[]> = {
  NWK: ["Newark Penn Station"],
  JSQ: ["Journal Sq"],
  GRV: ["Grove St Jersey City"],
  NEW: ["Pavonia Newport"],
  WTC: ["Oculus"],
  HOB: ["Hoboken Terminal"],
  "33S": ["Herald Square"],
};

const STATION_BY_ID = new Map(PATH_STATIONS.map((s) => [s.id, s]));

/** A station by its id, case insensitive. */
export function pathStation(raw: string): PathStation | undefined {
  return STATION_BY_ID.get(raw.trim().toUpperCase());
}

export function routesOf(station: PathStation): PathRoute[] {
  return station.routes.flatMap((id) => ROUTE_BY_ID.get(id) ?? []);
}

const SEARCH = PATH_STATIONS.map((station) => ({
  item: station,
  names: [station.name, station.id, ...(ALIASES[station.id] ?? [])].map(tokenize),
}));

/**
 * Stations matching a name, best first, with the subway search's rules ("wtc", "9th st",
 * "journal sq", "grove"). Ties keep the station list's order.
 */
export function searchPathStations(query: string): PathStation[] {
  return rankByName(SEARCH, query);
}
