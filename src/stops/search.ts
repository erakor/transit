import type { StationInfo, SubwayData } from "#src/static/types.js";

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

/** Something findable by name: `names` are the tokenized names it answers to. */
export interface NameEntry<T> {
  item: T;
  names: string[][];
}

/**
 * Every query token must prefix some token of one of the entry's names. Exact names rank first,
 * then names starting with the query, then other matches; `tieBreak` orders equal scores, and
 * without it they keep the entries' order.
 */
export function rankByName<T>(entries: readonly NameEntry<T>[], query: string, tieBreak?: (a: T, b: T) => number): T[] {
  const q = tokenize(query);
  if (q.length === 0) return [];
  const joined = q.join(" ");
  const hits: { item: T; score: number }[] = [];
  for (const e of entries) {
    let best = 0;
    for (const name of e.names) {
      if (!q.every((t) => name.some((n) => n.startsWith(t)))) continue;
      const full = name.join(" ");
      best = Math.max(best, full === joined ? 3 : full.startsWith(joined) ? 2 : 1);
    }
    if (best > 0) hits.push({ item: e.item, score: best });
  }
  return hits.sort((a, b) => b.score - a.score || (tieBreak?.(a.item, b.item) ?? 0)).map((h) => h.item);
}

export class StopSearch {
  private readonly entries: NameEntry<StationInfo>[];

  constructor(data: SubwayData) {
    this.entries = data.stations.map((station) => ({
      item: station,
      // Every member stop name, so "Port Authority" finds the Times Sq complex.
      names: [...new Set([station.name, ...station.stops.map((s) => data.stops[s]?.name ?? "")])]
        .filter(Boolean)
        .map(tokenize),
    }));
  }

  /** See `rankByName`; ties go to busier stations, then by name. */
  search(query: string, limit: number): StationInfo[] {
    return rankByName(this.entries, query, (a, b) => b.routes.length - a.routes.length || a.name.localeCompare(b.name)).slice(0, limit);
  }
}
