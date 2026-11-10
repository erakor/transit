import { fetchGbfs } from "../citibike/feeds.js";
import { joinStations, nearestStations, type BikeStations } from "../citibike/stations.js";
import { authenticated, errorResponse, intParam, json, LIVE_CACHE } from "../http.js";
import type { Fetcher } from "../subway/feeds.js";

export interface CitibikeDeps {
  fetcher?: Fetcher;
  now?: () => number;
}

/** Both GBFS feeds, joined. Undefined when either is unavailable: one without the other is no answer. */
async function loadStations({ fetcher, now = () => Date.now() }: CitibikeDeps): Promise<BikeStations | undefined> {
  const opts = { fetcher, now: now() };
  try {
    const [information, status] = await Promise.all([fetchGbfs("station_information", opts), fetchGbfs("station_status", opts)]);
    return joinStations(information, status);
  } catch (err) {
    console.error("citibike feeds failed:", err);
    return undefined;
  }
}

const UNAVAILABLE = "Citi Bike feeds unavailable";

/** GET /citibike/station?id=<station id>: bikes, e-bikes and free docks at one station. */
export function citibikeStationHandler(deps: CitibikeDeps = {}) {
  return authenticated(async (_request, url) => {
    const id = url.searchParams.get("id")?.trim();
    if (!id) return errorResponse(400, "id is required");
    const stations = await loadStations(deps);
    if (!stations) return errorResponse(502, UNAVAILABLE);
    const station = stations.byId.get(id) ?? stations.byId.get(id.toLowerCase());
    if (!station) return errorResponse(404, `unknown station ${id}`);
    return json({ updatedAt: stations.updatedAt, station }, { cache: LIVE_CACHE });
  });
}

function coordinate(url: URL, name: string, max: number): number | { error: string } {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return { error: `${name} is required` };
  const value = Number(raw);
  if (!/^-?\d+(\.\d+)?$/.test(raw) || Math.abs(value) > max) return { error: `${name} must be a number between -${max} and ${max}` };
  return value;
}

/** GET /citibike/nearby?lat=<lat>&lon=<lon>&n=<default 5, max 25>: the closest stations, nearest first. */
export function citibikeNearbyHandler(deps: CitibikeDeps = {}) {
  return authenticated(async (_request, url) => {
    const lat = coordinate(url, "lat", 90);
    if (typeof lat !== "number") return errorResponse(400, lat.error);
    const lon = coordinate(url, "lon", 180);
    if (typeof lon !== "number") return errorResponse(400, lon.error);
    const n = intParam(url, "n", 5, 25);
    if (typeof n !== "number") return errorResponse(400, n.error);

    const stations = await loadStations(deps);
    if (!stations) return errorResponse(502, UNAVAILABLE);
    return json(
      { lat, lon, updatedAt: stations.updatedAt, stations: nearestStations(stations.byId.values(), lat, lon, n) },
      { cache: LIVE_CACHE },
    );
  });
}
