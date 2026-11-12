import type { AgencyData, AgencyRoute, AgencyStop, AgencyTrip } from "#src/agency/types.js";
import { DEFAULT_COLOR, hex, requireFiles, round, type GtfsFiles } from "./build.js";
import { forEachCsvRow, parseCsvObjects } from "./csv.js";

/** "25:10:30" (GTFS times run past midnight) as seconds. */
function seconds(time: string): number {
  const [h, m, s] = time.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/**
 * Turns an agency's static GTFS into {@link AgencyData}: routes, stops with the routes serving
 * them and, with `trips`, each trip's route, headsign and stop offsets. Deterministic: keys are
 * sorted, so the same GTFS gives a byte-identical file.
 */
export function buildAgencyData(files: GtfsFiles, { trips: withTrips = false }: { trips?: boolean } = {}): AgencyData {
  requireFiles(files);

  const routes: Record<string, AgencyRoute> = {};
  for (const r of parseCsvObjects(files["routes.txt"]!)) {
    if (!r.route_id) continue;
    routes[r.route_id] = {
      id: r.route_id,
      name: r.route_long_name || r.route_short_name || r.route_id,
      color: hex(r.route_color, DEFAULT_COLOR),
      textColor: hex(r.route_text_color, "FFFFFF"),
    };
  }
  const byRouteName = (a: string, b: string) =>
    (routes[a]?.name ?? a).localeCompare(routes[b]?.name ?? b) || a.localeCompare(b);

  const stops: Record<string, AgencyStop> = {};
  for (const s of parseCsvObjects(files["stops.txt"]!)) {
    // Boarding places only: these agencies publish no parent stations or entrances worth keeping.
    if (!s.stop_id || (s.location_type && s.location_type !== "0")) continue;
    stops[s.stop_id] = {
      id: s.stop_id,
      name: s.stop_name || s.stop_id,
      lat: round(Number(s.stop_lat)),
      lon: round(Number(s.stop_lon)),
      routes: [],
    };
  }

  const routeOfTrip = new Map<string, string>();
  forEachCsvRow(files["trips.txt"]!, ["trip_id", "route_id"], ([trip, route]) => {
    if (trip && route) routeOfTrip.set(trip, route);
  });

  const routeSets = new Map<string, Set<string>>();
  const calls = new Map<string, [seq: number, stop: string, time: number][]>();
  forEachCsvRow(
    files["stop_times.txt"]!,
    ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"],
    ([trip, stop, seq, arrival, departure]) => {
      const route = routeOfTrip.get(trip!);
      if (!route || !stops[stop!]) return;
      let set = routeSets.get(stop!);
      if (!set) routeSets.set(stop!, (set = new Set()));
      set.add(route);
      if (!withTrips) return;
      const time = arrival || departure;
      if (!time) return;
      let list = calls.get(trip!);
      if (!list) calls.set(trip!, (list = []));
      list.push([Number(seq), stop!, seconds(time)]);
    },
  );
  for (const [id, set] of routeSets) stops[id]!.routes = [...set].sort(byRouteName);

  const sortedRoutes: Record<string, AgencyRoute> = {};
  for (const k of Object.keys(routes).sort(byRouteName)) sortedRoutes[k] = routes[k]!;
  const sortedStops: Record<string, AgencyStop> = {};
  for (const k of Object.keys(stops).sort()) sortedStops[k] = stops[k]!;
  const feedInfo = files["feed_info.txt"] ? parseCsvObjects(files["feed_info.txt"])[0] : undefined;
  const data: AgencyData = { feedVersion: feedInfo?.feed_version ?? "", routes: sortedRoutes, stops: sortedStops };

  if (withTrips) {
    const trips: Record<string, AgencyTrip> = {};
    for (const id of [...calls.keys()].sort()) {
      const list = calls.get(id)!.sort((a, b) => a[0] - b[0]);
      trips[id] = {
        route: routeOfTrip.get(id)!,
        // The last stop's name, not trip_headsign: NYC Ferry spells its headsigns several ways
        // ("Wall St./Pier 11 (E R A)"), and a trip ending at a stop must read as that stop.
        headsign: stops[list[list.length - 1]![1]]!.name,
        stops: list.map(([, stop, time]) => [stop, time - list[0]![2]]),
      };
    }
    data.trips = trips;
  }
  return data;
}
