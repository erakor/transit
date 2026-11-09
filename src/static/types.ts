/** Compact, pre-joined static subway data produced by scripts/build-static.ts. */

export interface RouteInfo {
  id: string;
  /** Rider-facing name, e.g. "A" or "S" for the shuttles. */
  shortName: string;
  longName: string;
  /** Hex color with leading "#". */
  color: string;
  textColor: string;
  sortOrder: number;
}

/** A GTFS parent station (location_type 1). Platforms are `${id}N` and `${id}S`. */
export interface StopInfo {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Routes with scheduled service at this stop, in route sort order. */
  routes: string[];
  /** Id of the station (complex) this stop belongs to. */
  station: string;
}

/**
 * A station complex: parent stops linked by in-station transfers.
 * A stop that is in no complex is its own station, with the stop id as station id.
 * A complex's id is its member stop ids, sorted and joined with "+", e.g. "127+725+902+A27+R16".
 */
export interface StationInfo {
  id: string;
  name: string;
  lat: number;
  lon: number;
  stops: string[];
  routes: string[];
}

export interface SubwayData {
  /** feed_version from feed_info.txt, so callers and /health can tell which schedule is loaded. */
  feedVersion: string;
  routes: Record<string, RouteInfo>;
  stops: Record<string, StopInfo>;
  stations: StationInfo[];
}
