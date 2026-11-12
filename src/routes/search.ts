import { SUBWAY_DATA } from '#src/data/subway.generated.js'
import { authenticated, json, STATIC_CACHE } from '#src/http.js'
import { parseQuery } from '#src/schema.js'
import { SearchQuery, type SearchResponse } from '#src/subway/schemas.js'
import { StopSearch } from '#src/stops/search.js'
import type { SubwayData } from '#src/static/types.js'

/** GET /stops/search?q=<name>&limit=<default 10, max 25> */
export function searchHandler(data: SubwayData = SUBWAY_DATA) {
  let search: StopSearch | undefined
  return authenticated((_request, url) => {
    const parsed = parseQuery(SearchQuery, url)
    if (!parsed.ok) return parsed.response
    const { q, limit } = parsed.query

    search ??= new StopSearch(data)
    const results: SearchResponse['results'] = search.search(q, limit).map(s => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      stops: s.stops.map(id => ({ id, name: data.stops[id]?.name ?? id })),
      // Diamond express variants (6X, 7X, FX) run on the same line as their base route.
      routes: s.routes
        .filter(r => !(r.endsWith('X') && s.routes.includes(r.slice(0, -1))))
        .map(r => {
          const route = data.routes[r]
          return {
            id: r,
            name: route?.shortName ?? r,
            color: route?.color ?? '#808183',
            textColor: route?.textColor ?? '#FFFFFF',
          }
        }),
    }))
    return json({ query: q, results }, { cache: STATIC_CACHE })
  })
}
