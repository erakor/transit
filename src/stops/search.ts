import type { StationInfo, SubwayData } from "../static/types.js";

/** Words riders type that the MTA abbreviates in stop names. */
const SYNONYMS: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "av",
  ave: "av",
  square: "sq",
  boulevard: "blvd",
  parkway: "pkwy",
  road: "rd",
  place: "pl",
  center: "ctr",
  centre: "ctr",
  heights: "hts",
  junction: "jct",
  saint: "st",
  fort: "ft",
  mount: "mt",
  terminal: "term",
  and: "",
};

/** Lowercase, accent-free tokens: "Bergen St/Café" -> ["bergen", "st", "cafe"]. "42nd" -> "42". */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .map((t) => SYNONYMS[t] ?? t)
    .filter((t) => t !== "");
}

export interface SearchHit {
  station: StationInfo;
  score: number;
}

interface Entry {
  station: StationInfo;
  /** Tokens of every member stop name, so "Port Authority" finds the Times Sq complex. */
  names: string[][];
}

export class StopSearch {
  private readonly entries: Entry[];

  constructor(data: SubwayData) {
    this.entries = data.stations.map((station) => ({
      station,
      names: [...new Set([station.name, ...station.stops.map((s) => data.stops[s]?.name ?? "")])]
        .filter(Boolean)
        .map(tokenize),
    }));
  }

  /**
   * Every query token must prefix some token of one of the station's names. Exact names rank
   * first, then names starting with the query, then other matches; ties go to busier stations.
   */
  search(query: string, limit: number): StationInfo[] {
    const q = tokenize(query);
    if (q.length === 0) return [];
    const joined = q.join(" ");
    const hits: SearchHit[] = [];
    for (const e of this.entries) {
      let best = -1;
      for (const name of e.names) {
        if (!q.every((t) => name.some((n) => n.startsWith(t)))) continue;
        const full = name.join(" ");
        const score = full === joined ? 3 : full.startsWith(joined) ? 2 : 1;
        best = Math.max(best, score);
      }
      if (best > 0) hits.push({ station: e.station, score: best });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.station.routes.length - a.station.routes.length ||
        a.station.name.localeCompare(b.station.name),
    );
    return hits.slice(0, limit).map((h) => h.station);
  }
}
