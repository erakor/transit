import { SUBWAY_DATA } from "#src/data/subway.generated.js";
import type { StationInfo, SubwayData } from "#src/static/types.js";

/** What `/subway/arrivals?stop=` resolved to: a station, a single stop, or one platform. */
export interface ResolvedStop {
  id: string;
  name: string;
  /** Parent stop ids covered. */
  stops: string[];
  /** Platform stop ids whose arrivals are returned (e.g. "127N", "127S"). */
  platforms: string[];
  routes: string[];
}

export class StationIndex {
  readonly byId = new Map<string, StationInfo>();

  constructor(readonly data: SubwayData) {
    for (const s of data.stations) this.byId.set(s.id, s);
  }

  /**
   * Accepts a station id from /stops/search ("127+725+902+A27+R16" or "101"), a parent stop
   * id ("127"), or a platform id ("127N"). Returns undefined for anything unknown.
   */
  resolve(raw: string): ResolvedStop | undefined {
    const id = raw.trim().toUpperCase();
    const station = this.byId.get(id);
    if (station) {
      return {
        id: station.id,
        name: station.name,
        stops: station.stops,
        platforms: station.stops.flatMap((s) => [s + "N", s + "S"]),
        routes: station.routes,
      };
    }
    const stop = this.data.stops[id];
    if (stop) {
      return { id: stop.id, name: stop.name, stops: [stop.id], platforms: [stop.id + "N", stop.id + "S"], routes: stop.routes };
    }
    const platform = /^(.+)([NS])$/.exec(id);
    const parent = platform ? this.data.stops[platform[1]!] : undefined;
    if (parent) {
      return { id, name: parent.name, stops: [parent.id], platforms: [id], routes: parent.routes };
    }
    return undefined;
  }

  /** Display name for a platform or parent stop id from a realtime feed. */
  stopName(id: string): string | undefined {
    return (this.data.stops[id] ?? this.data.stops[id.replace(/[NS]$/, "")])?.name;
  }
}

let defaultIndex: StationIndex | undefined;
export function stationIndex(): StationIndex {
  return (defaultIndex ??= new StationIndex(SUBWAY_DATA));
}
