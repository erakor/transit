import { forEachCsvRow, parseCsvObjects } from "./csv.js";
import type { RouteInfo, StationInfo, StopInfo, SubwayData } from "./types.js";

/** The GTFS files the build reads, as text keyed by file name. */
export type GtfsFiles = Record<string, string>;

const REQUIRED = ["routes.txt", "stops.txt", "trips.txt", "stop_times.txt"];
export const DEFAULT_COLOR = "808183";

export function requireFiles(files: GtfsFiles): void {
  for (const f of REQUIRED) {
    if (files[f] === undefined) throw new Error(`GTFS is missing ${f}`);
  }
}

export function hex(c: string | undefined, fallback: string): string {
  const v = (c ?? "").replace(/^#/, "").toUpperCase();
  return "#" + (/^[0-9A-F]{6}$/.test(v) ? v : fallback);
}

export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Turns the static MTA subway GTFS into the compact {@link SubwayData} the functions load. */
export function buildSubwayData(files: GtfsFiles): SubwayData {
  requireFiles(files);

  // Routes.
  const routes: Record<string, RouteInfo> = {};
  for (const r of parseCsvObjects(files["routes.txt"]!)) {
    if (!r.route_id) continue;
    routes[r.route_id] = {
      id: r.route_id,
      shortName: r.route_short_name || r.route_id,
      longName: r.route_long_name ?? "",
      color: hex(r.route_color, DEFAULT_COLOR),
      textColor: hex(r.route_text_color, "FFFFFF"),
      sortOrder: Number(r.route_sort_order) || 999,
    };
  }
  const byRouteOrder = (a: string, b: string) =>
    (routes[a]?.sortOrder ?? 999) - (routes[b]?.sortOrder ?? 999) || a.localeCompare(b);

  // Stops: keep parent stations; map every platform to its parent.
  const parentOf = new Map<string, string>();
  const stops: Record<string, StopInfo> = {};
  const stopRows = parseCsvObjects(files["stops.txt"]!);
  for (const s of stopRows) {
    if (!s.stop_id || s.location_type !== "1") continue;
    stops[s.stop_id] = {
      id: s.stop_id,
      name: s.stop_name ?? s.stop_id,
      lat: round(Number(s.stop_lat)),
      lon: round(Number(s.stop_lon)),
      routes: [],
      station: s.stop_id,
    };
  }
  for (const s of stopRows) {
    if (!s.stop_id) continue;
    if (s.parent_station && stops[s.parent_station]) parentOf.set(s.stop_id, s.parent_station);
    else if (stops[s.stop_id]) parentOf.set(s.stop_id, s.stop_id);
  }

  // Routes serving each stop, from the scheduled trips.
  const routeOfTrip = new Map<string, string>();
  forEachCsvRow(files["trips.txt"]!, ["trip_id", "route_id"], ([trip, route]) => {
    routeOfTrip.set(trip!, route!);
  });
  const routeSets = new Map<string, Set<string>>();
  forEachCsvRow(files["stop_times.txt"]!, ["trip_id", "stop_id"], ([trip, stop]) => {
    const parent = parentOf.get(stop!);
    const route = routeOfTrip.get(trip!);
    if (!parent || !route) return;
    let set = routeSets.get(parent);
    if (!set) routeSets.set(parent, (set = new Set()));
    set.add(route);
  });
  for (const [id, set] of routeSets) stops[id]!.routes = [...set].sort(byRouteOrder);

  // Station complexes: connected components of in-station transfers between different stops.
  const link = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (link.has(root)) root = link.get(root)!;
    while (x !== root) {
      const next = link.get(x)!;
      link.set(x, root);
      x = next;
    }
    return root;
  };
  if (files["transfers.txt"]) {
    for (const t of parseCsvObjects(files["transfers.txt"])) {
      const a = parentOf.get(t.from_stop_id ?? "");
      const b = parentOf.get(t.to_stop_id ?? "");
      if (!a || !b || a === b) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) link.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of Object.keys(stops)) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.push(id);
    else groups.set(root, [id]);
  }

  const stations: StationInfo[] = [];
  for (const members of groups.values()) {
    members.sort();
    const id = members.join("+");
    const infos = members.map((m) => stops[m]!);
    for (const s of infos) s.station = id;
    stations.push({
      id,
      name: stationName(infos),
      lat: round(infos.reduce((a, s) => a + s.lat, 0) / infos.length),
      lon: round(infos.reduce((a, s) => a + s.lon, 0) / infos.length),
      stops: members,
      routes: [...new Set(infos.flatMap((s) => s.routes))].sort(byRouteOrder),
    });
  }
  stations.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const feedInfo = files["feed_info.txt"] ? parseCsvObjects(files["feed_info.txt"])[0] : undefined;

  // Stable key order so a rebuild from the same GTFS gives a byte-identical file.
  const sortedStops: Record<string, StopInfo> = {};
  for (const k of Object.keys(stops).sort()) sortedStops[k] = stops[k]!;
  const sortedRoutes: Record<string, RouteInfo> = {};
  for (const k of Object.keys(routes).sort(byRouteOrder)) sortedRoutes[k] = routes[k]!;

  return {
    feedVersion: feedInfo?.feed_version ?? "",
    routes: sortedRoutes,
    stops: sortedStops,
    stations,
  };
}

/** The most common member name; ties go to the member serving the most routes. */
function stationName(members: StopInfo[]): string {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return [...members].sort(
    (a, b) =>
      counts.get(b.name)! - counts.get(a.name)! ||
      b.routes.length - a.routes.length ||
      a.id.localeCompare(b.id),
  )[0]!.name;
}
