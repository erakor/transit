# transit

A small NYC transit data service. It fetches the upstream feeds, normalizes them and serves
small, pre-joined JSON to apps and servers (the alfresco launcher and other personal projects),
so clients never touch protobuf or GTFS.

v1 covers the MTA subway. PATH, Citi Bike and MTA bus will be added later as their own route
groups (`/path/...`, `/citibike/...`, `/bus/...`) with the same conventions.

Runs on Vercel, one serverless function per route, TypeScript.

## Endpoints

All JSON. Times are epoch seconds. Every route except `/health` needs the client token.

### `GET /subway/arrivals?stop=<id>&limit=<n>`

Next trains per route and direction.

- `stop`: a station id from `/stops/search` (for a complex, its stop ids joined with `+`, such as
  `127+725+902+A27+R16`), a single GTFS stop id (`127`), or one platform (`127N`, `127S`).
  Case insensitive. Remember to URL-encode `+` as `%2B`.
- `limit`: trains per route and direction, default 3, max 10.

```json
{
  "stop": { "id": "127+725+902+A27+R16", "name": "Times Sq-42 St", "stops": ["127", "725", "902", "A27", "R16"] },
  "updatedAt": 1794232808,
  "groups": [
    {
      "route": "A", "name": "A", "color": "#0062CF", "textColor": "#FFFFFF",
      "direction": "N", "headsign": "Inwood-207 St",
      "arrivals": [
        { "time": 1794233022, "headsign": "Inwood-207 St", "tripId": "046300_A..N18R" },
        { "time": 1794233173, "headsign": "Inwood-207 St", "tripId": "048700_A..N20X002" }
      ]
    }
  ]
}
```

- `direction` is the MTA platform direction: `N` (northbound, generally uptown or toward the
  Bronx/Queens) or `S`. `headsign` is the last stop of the train's trip, so it's the best label.
- `name` is the rider-facing route name (`S` for the shuttles, whose `route` is `GS`, `FS` or `H`).
  Diamond express trips keep their own route id (`6X`, `7X`, `FX`).
- Groups are in MTA route order, then `N` before `S`.
- `updatedAt` is the oldest feed timestamp used.
- If some upstream feeds failed, the response is still 200 with what was available and an
  `unavailableFeeds` array; if all of them failed it is 502.
- Errors: 400 (missing `stop`, bad `limit`), 404 (unknown stop), 401 (token), 502 (MTA down).
  Error bodies are `{ "error": "..." }`.

### `GET /stops/search?q=<text>&limit=<n>`

Subway station lookup by name, case and accent insensitive. Riders' spellings work too:
"times square", "42nd street", "jackson heights", "Port Authority" (other names in a complex
match). `limit` defaults to 10, max 25.

```json
{
  "query": "bedford av",
  "results": [
    {
      "id": "L08", "name": "Bedford Av", "lat": 40.717304, "lon": -73.956872,
      "stops": [{ "id": "L08", "name": "Bedford Av" }],
      "routes": [{ "id": "L", "name": "L", "color": "#7C858C", "textColor": "#FFFFFF" }]
    }
  ]
}
```

`id` goes straight into `/subway/arrivals?stop=`.

### `GET /health`

No token, never cached: `{ "ok": true, "staticFeedVersion": "...", "time": 1794232808 }`.

## Authentication

Send the token in a custom header:

```
X-Transit-Token: <token>
```

A missing or wrong token is a 401.

**Why not `Authorization: Bearer`?** Vercel's CDN does not cache responses to requests that carry
an `Authorization` header ([Vercel docs, "Cacheable response criteria"](https://vercel.com/docs/caching/cdn-cache):
"Request doesn't contain Authorization header"). With it, every call would run the function and
hit the MTA. With `X-Transit-Token`, responses are cacheable, and every authenticated response
carries `Vary: X-Transit-Token`, so the token is part of the CDN cache key: a request with a missing
or wrong token never matches a cached 200 and always reaches the function (which returns an
uncached 401). Since all clients share one token, this adds no cache fragmentation.

`Authorization: Bearer <token>` is still accepted, for tools that only speak that, but those
responses are never served from the CDN.

The server reads the token from the `TRANSIT_TOKEN` environment variable (set in Vercel only,
never committed). It may hold several comma-separated tokens, for rotation: add the new one,
update clients, remove the old one. If it's unset, authenticated routes answer 500.

## Caching

| Route | `Cache-Control` |
| --- | --- |
| `/subway/arrivals` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/subway/arrivals` with failed feeds | `public, s-maxage=5` |
| `/stops/search` | `public, s-maxage=3600, stale-while-revalidate=86400` (static data only changes with a deploy, and Vercel purges the CDN cache on each production deploy) |
| `/health`, errors | `no-store` |

So the CDN calls the function about once per 20 s per distinct URL. Behind it, each function
instance keeps decoded feeds in memory for 15 s and coalesces concurrent fetches, so different
stops on the same line within a window share one MTA request. `x-vercel-cache` on a response
tells whether the CDN served it (`HIT`, `STALE`) or not (`MISS`).

## Data

- **Real time**: the MTA subway GTFS-realtime feeds (no API key), one per line group (see
  `FEEDS` in `src/subway/feeds.ts`), decoded with `gtfs-realtime-bindings`. A request fetches,
  in parallel, only the feeds carrying routes scheduled at the requested stop.
- **Static**: the MTA static subway GTFS is preprocessed by `scripts/build-static.ts` into
  `src/data/subway.generated.ts` (routes with colors, parent stops with the routes serving them,
  and station complexes built from in-station transfers in `transfers.txt`). The file is
  committed, so builds and tests don't depend on the MTA. The **Refresh static GTFS** workflow
  regenerates it daily and commits it when it changed, which triggers a Vercel deploy. (A Vercel
  Cron job can't do this: it runs a function, and a function can't change the deployed bundle.)

## Development

```sh
npm install
npm test               # unit tests (recorded feeds in test/fixtures)
npm run typecheck
npm run build:static   # regenerate src/data/subway.generated.ts from the MTA
npm run record-fixtures  # re-record test/fixtures/*.pb from the live feeds
npm run smoke          # check the live MTA feeds (see below)
```

Layout:

```
api/                 one Vercel function per route (thin: they export GET from src/routes)
src/routes/          handlers: arrivals, search, health
src/subway/          feed list, fetching and decoding, arrivals computation
src/stops/           station resolution and name search
src/static/          static GTFS preprocessing (pure) and its types
src/data/            generated static data
scripts/             build-static, record-fixtures, smoke
test/                vitest tests and fixture feeds
vercel.json          rewrites /health, /subway/*, /stops/* to the functions
```

To run locally against Vercel's runtime, use `vercel dev` with `TRANSIT_TOKEN` in `.env.local`
(see `.env.example`).

## Deploying

1. Import the repo in Vercel (framework preset "Other", no build command needed).
2. Set `TRANSIT_TOKEN` in Project Settings, Environment Variables (Production and Preview).
   Generate one with `openssl rand -base64 32`.
3. Deploy. Optionally add the repository secrets `TRANSIT_BASE_URL` (such as
   `https://transit-xyz.vercel.app`) and `TRANSIT_TOKEN` so the scheduled smoke test also checks
   the deployment.

### Verifying a deployment

```sh
BASE=https://<deployment>
TOKEN=<token>
STOP=127%2B725%2B902%2BA27%2BR16

curl -i "$BASE/health"                                                  # 200
curl -i "$BASE/subway/arrivals?stop=$STOP"                              # 401
curl -i -H "X-Transit-Token: wrong" "$BASE/subway/arrivals?stop=$STOP"  # 401
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/subway/arrivals?stop=$STOP" # 200
curl -s -o /dev/null -D - -H "X-Transit-Token: $TOKEN" "$BASE/subway/arrivals?stop=$STOP" | grep -i x-vercel-cache  # HIT
curl -i "$BASE/stops/search?q=bedford"                                  # 401
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/stops/search?q=bedford"     # 200
```

Or run `TRANSIT_BASE_URL=$BASE TRANSIT_TOKEN=$TOKEN npm run smoke`, which does the same checks.

## Testing

- `test/static-build.test.ts`: CSV parsing and the static GTFS preprocessing on a small GTFS
  sample, plus sanity checks on the committed data.
- `test/arrivals.test.ts`: arrivals on a hand-built protobuf feed (grouping, ordering, past and
  skipped stops, complexes, platforms) and on recorded feeds for all eight MTA feeds.
- `test/auth.test.ts`, `test/routes.test.ts`: the token check, status codes, `Cache-Control`
  and `Vary` headers, partial feed failures, search ranking.
- `.github/workflows/smoke.yml`: twice a day against the live feeds. It fails on stale feeds,
  routes missing from `FEEDS`, many stop ids missing from the static data, or a big station with
  no arrivals.

## Adding a provider later

Same conventions: one function per route under `api/<provider>/`, a handler in `src/routes/`
wrapped in `authenticated(...)`, `LIVE_CACHE` or `STATIC_CACHE` headers, names rather than bare
ids, epoch seconds. Keys for upstreams that need one (MTA Bus Time) go in Vercel environment
variables, never in the repo.

## Clients

Clients send `X-Transit-Token` (not `Authorization`) so their calls are CDN-cacheable. Favorite
stops live in each client; the service is stateless. For alfresco (Swift), the base URL and token
are read like `Config.weatherAPIKey()`, and a nil token turns the feature off.
