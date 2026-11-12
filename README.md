# transit

A small NYC transit data service. It fetches the upstream feeds, normalizes them and serves
small, pre-joined JSON to apps and servers (the alfresco launcher and other personal projects),
so clients never touch protobuf or GTFS.

It covers the MTA subway (arrivals, alerts, train positions), PATH, the LIRR, Metro-North and
NYC Ferry, MTA buses (arrivals by stop code, alerts) and Citi Bike stations. NJ Transit will be
added later as its own route group with the same conventions.

Runs on Vercel, TypeScript: ten serverless functions, most serving a provider's routes together.

## Endpoints

All JSON. Times are epoch seconds. Every route needs the client token except `/health`, `/docs` and
`/openapi.json`.

`/docs` is an interactive reference for every route, generated from the routes' schemas
(`/openapi.json`).

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

### `GET /preview/subway?q=<station name>` or `?stop=<id>`

One line of plain text (`text/plain`, newline-terminated) for clients that show a single line,
such as the alfresco launcher's hint: the station, then each route's next train per direction in
whole minutes (rounded down), `↑` for the northbound platform and `↓` for the southbound one.

```
Bedford Av · L ↑2 ↓4 min
```

- `q` takes the top `/stops/search` result; `stop` takes the same ids as `/subway/arrivals`.
- At most 6 routes, then `· …`. No train coming reads `<station> · no trains soon`.
- Errors are JSON like every other route (400 without `q` or `stop`, 404 for no match, 502 when
  every feed failed), so a client that wants a line of text simply ignores them.
- `Cache-Control` adds `max-age` to the CDN's window, so the client knows how long its own copy
  stays good.

### `GET /path/arrivals?station=<id>&limit=<n>`

Next PATH trains per route and direction.

- `station`: a station id from `/path/stations`, case insensitive: `NWK`, `HAR`, `JSQ`, `GRV`,
  `EXP`, `WTC`, `NEW` (Newport), `HOB`, `CHR`, `09S`, `14S`, `23S`, `33S`.
- `limit`: trains per route and direction, default 3, max 10. The Port Authority lists only the
  next few trains per station, so a group often holds one or two.

```json
{
  "station": { "id": "GRV", "name": "Grove Street" },
  "updatedAt": 1794320232,
  "groups": [
    {
      "route": "NWK-WTC", "name": "Newark - World Trade Center", "color": "#D93A30", "textColor": "#FFFFFF",
      "direction": "NJ", "headsign": "Newark",
      "arrivals": [{ "time": 1794320471, "headsign": "Newark" }]
    },
    {
      "route": "JSQ-33", "name": "Journal Square - 33rd Street", "color": "#FF9900", "textColor": "#FFFFFF",
      "direction": "NY", "headsign": "33rd Street",
      "arrivals": [{ "time": 1794320385, "headsign": "33rd Street" }]
    }
  ]
}
```

- `direction` is the feed's own label at that station: `NY` (toward Manhattan) or `NJ`.
  `headsign` is where the train ends, so it's the best label.
- Routes: `NWK-WTC`, `HOB-WTC`, `JSQ-33`, `HOB-33`, and `JSQ-33-HOB` (Journal Square to 33rd
  Street via Hoboken, nights and weekends). Groups are in that order, then `NY` before `NJ`.
- The feed refreshes about once a minute and shows a train standing at the platform as 0 seconds
  away, so `time` can be up to 2 minutes in the past: read that as "boarding". There is no trip id.
- `updatedAt` is the oldest update time among the station's trains, `null` when the feed lists none.
- Errors: 400 (missing `station`, bad `limit`), 404 (unknown station), 401 (token), 502 (the
  Port Authority feed is down).

### `GET /path/stations`

The 13 PATH stations, in line order, with the routes serving each:

```json
{
  "stations": [
    {
      "id": "NWK", "name": "Newark",
      "routes": [{ "id": "NWK-WTC", "name": "Newark - World Trade Center", "color": "#D93A30", "textColor": "#FFFFFF" }]
    }
  ]
}
```

### `GET /preview/path?q=<station name>` or `?station=<id>`

Like `/preview/subway`, for PATH: the station, then the next train to each destination in whole
minutes (rounded down), soonest first.

```
Grove Street · Journal Square 0 · 33rd Street 1 · Newark 3 min
```

`q` matches like `/stops/search` does ("wtc", "9th st", "journal sq", "grove"). Same errors,
caching and `no trains soon` line as `/preview/subway`.

### `GET /subway/alerts`, optionally `?route=<id>` or `?stop=<id>`

The service alerts in effect right now: incidents first, then planned work, newest first.

- `route`: a subway route id (`A`, `6X`, `GS`). `stop`: the same ids as `/subway/arrivals`; it
  keeps alerts that name one of the station's stops, and route-wide alerts for routes that stop
  there. Both can be combined. With neither, every subway alert in effect.

```json
{
  "updatedAt": 1794322719,
  "alerts": [
    {
      "id": "lmm:alert:275694:26", "planned": false,
      "header": "Downtown [A][B][C][D] trains are running with delays while we address a signal malfunction near 135 St.",
      "description": "For skipped stops, take an uptown [B][C] train.",
      "routes": [{ "id": "A", "name": "A", "color": "#0062CF", "textColor": "#FFFFFF" }],
      "stops": [],
      "start": 1794320575, "end": null
    }
  ]
}
```

- `header` and `description` are plain text (the MTA writes routes in brackets); `description`
  is `""` when there is none. `planned` is true for scheduled work.
- `start` and `end` are the period in effect now; planned work lists one period per affected
  night, and only alerts with a period covering the present are returned.
- With `stop`, the response also carries the resolved `stop`, as in `/subway/arrivals`.
- The feeds don't give a category ("Delays", "Planned - Stops Skipped") in a form this service
  decodes, so there is none.
- Errors: 404 (unknown route or stop), 401, 502.

`/lirr/alerts`, `/mnr/alerts` and `/ferry/alerts` answer the same shape, filtered with `route`
and `station` (`stop` for the ferry). `/bus/alerts?route=<id>` (`Q29`, `S79+`, `SIM10`) does too,
with route names and colors from the static bus data, but names no stops: there is no bus stop
data.

### `GET /subway/vehicles?route=<id>`

Where a route's trains are. The subway feeds carry no coordinates, so each train has the stop it
is at or heading to.

```json
{
  "route": { "id": "L", "name": "L", "color": "#7C858C", "textColor": "#FFFFFF" },
  "updatedAt": 1794322787,
  "vehicles": [
    { "tripId": "056350_L..N", "direction": "N", "headsign": "8 Av", "status": "STOPPED_AT",
      "stop": { "id": "L02N", "name": "6 Av" }, "time": 1794322775 }
  ]
}
```

`status` is `STOPPED_AT`, `INCOMING_AT` or `IN_TRANSIT_TO`, relative to `stop`. Northbound trains
first, each direction in stop id order. Trains that last reported over 15 minutes ago are left
out. Errors: 400 (missing `route`), 404 (unknown route), 401, 502.

### LIRR, Metro-North and NYC Ferry

Three agencies with the same routes: `/lirr/...`, `/mnr/...` and `/ferry/...`. The railroads call
a stop a `station`, the ferry a `stop`, in paths, parameters and response keys alike.

#### `GET /lirr/stations`, `/mnr/stations`, `/ferry/stops`, optionally `?q=<name>&limit=<n>`

Every station by name, or with `q` the ones matching it, best first, like `/stops/search`
(`limit` defaults to 10, max 25).

```json
{
  "query": "white plains",
  "stations": [
    { "id": "74", "name": "White Plains", "lat": 41.032589, "lon": -73.775208,
      "routes": [{ "id": "2", "name": "Harlem", "color": "#0039A6", "textColor": "#FFFFFF" }] }
  ]
}
```

`id` is the agency's GTFS `stop_id` and goes into the routes below.

#### `GET /lirr/arrivals?station=<id>&limit=<n>` (`/mnr/arrivals`, `/ferry/arrivals?stop=<id>`)

The next departures, soonest first, in one list for all routes and directions, like a station's
departure board. `limit` defaults to 10, max 30.

```json
{
  "station": { "id": "102", "name": "Jamaica" },
  "updatedAt": 1794322787,
  "arrivals": [
    { "time": 1794323029, "delay": 109, "route": "10", "name": "Port Jefferson Branch",
      "color": "#006EC7", "textColor": "#FFFFFF", "headsign": "Huntington", "tripId": "GO203_26_1518_1" }
  ]
}
```

- `time` is when the train leaves the station (when it arrives, where its trip ends there).
- `delay` is seconds behind schedule, present when the feed gives it (the railroads do, the
  ferry doesn't).
- `headsign` is the trip's last stop. A trip that ends at the requested station is listed too,
  with the station's own name as `headsign`.
- Track numbers are not included: the railroads publish them in a feed extension this service
  doesn't decode.
- **Ferry times past the next stop are estimates.** NYC Ferry's feed predicts only each boat's
  next stop. Later stops are that prediction plus the scheduled running time from there, so the
  boat's current delay carries down the line. Boats not yet assigned to a trip don't appear.
- Errors: 400 (missing `station`, bad `limit`), 404 (unknown station), 401, 502.

#### `GET /lirr/vehicles`, `/mnr/vehicles`, `/ferry/vehicles`, optionally `?route=<id>`

Where the trains or boats are, with coordinates.

```json
{
  "updatedAt": 1794322789,
  "vehicles": [
    { "id": "41", "label": "H111", "tripId": "1013",
      "route": { "id": "AS", "name": "Astoria", "color": "#FF6B00", "textColor": "#FFFFFF" },
      "headsign": "Wall St/Pier 11", "lat": 40.70783, "lon": -73.97942,
      "status": "IN_TRANSIT_TO", "stop": null, "time": 1794322788 }
  ]
}
```

`route`, `stop`, `status` and `time` are `null` when the feed doesn't say (the ferry names no
stop). Positions older than 15 minutes are left out. Sorted by route name.

#### `GET /preview/lirr`, `/preview/mnr`, `/preview/ferry`: `?q=<name>` or `?station=<id>` (`?stop=<id>`)

One line like `/preview/path`: the next departure to each destination, at most 6, soonest first.
Trips ending at the station are left out.

```
Penn Station · Ronkonkoma 1 · Huntington 9 · Port Washington 16 · Babylon 32 · Long Beach 42 min
```

### `GET /bus/arrivals?stop=<code>&limit=<n>`

The buses on their way to one stop, from MTA Bus Time, every route in one list. `stop` is the
six-digit code on the bus stop sign (`401687`; `MTA_401687`, as Bus Time writes it, works too).
There is no bus stop search yet. `limit` defaults to 10, max 30.

```json
{
  "stop": { "id": "401687", "name": "1 AV/E 14 ST" },
  "updatedAt": 1794334736,
  "arrivals": [
    {
      "time": 1794334870,
      "route": "M15+",
      "name": "M15-SBS",
      "color": "#B933AD",
      "textColor": "#FFFFFF",
      "headsign": "SBS EAST HARLEM 126 ST via 1 AV",
      "distance": "approaching",
      "stopsAway": 1,
      "meters": 412,
      "atTerminal": false,
      "vehicle": "5791",
      "tripId": "MTA NYCT_MQ_D6-Weekday-SDon-077800_M15+_731"
    }
  ]
}
```

- Predicted buses come first, soonest first. `time` is null when Bus Time has no prediction,
  usually for a bus still at its terminal (`atTerminal`); those follow, nearest first.
- `distance` is Bus Time's text for riders; `stopsAway` and `meters` are null when unknown.
- `route` is the GTFS route id, as in `/bus/alerts`; `name` is what the bus shows.
- `stop.name` comes from Bus Time and is null when no bus is on its way.
- Errors: 400 (missing or malformed `stop`), 404 (Bus Time knows no such stop), 401, 502 (Bus
  Time failed), 500 (`BUSTIME_KEY` not set on the server).

### `GET /preview/bus?stop=<code>`

One line like the other previews: the next bus of each route, soonest first.

```
1 AV/E 14 ST · M15-SBS 2 · M15 5 min
```

### `GET /citibike/nearby?lat=<lat>&lon=<lon>&n=<n>`

The Citi Bike stations closest to a point, nearest first. `n` defaults to 5, max 25.

```json
{
  "lat": 40.7559, "lon": -73.9871,
  "updatedAt": 1794322409,
  "stations": [
    {
      "id": "f72a253f-3cef-4da8-9591-0cbd3a692162", "name": "W 40 St & 7 Ave",
      "lat": 40.754818, "lon": -73.988154, "capacity": 45,
      "bikes": 9, "ebikes": 28, "docks": 2,
      "renting": true, "returning": true, "reportedAt": 1794322384,
      "distance": 150
    }
  ]
}
```

- `bikes` are classic bikes and `ebikes` are e-bikes, both ready to rent (so the total is their
  sum); `docks` are free docks. `capacity` is every dock at the station, in any state.
- `renting` and `returning` are false when the station is closed for rentals or returns: the
  counts are still reported, but can't be used.
- `distance` is meters from the requested point, as the crow flies.
- `reportedAt` is when the station itself last reported (absent if it never did); `updatedAt`
  is the status feed's timestamp.
- Stations that are listed but not on the street (planned, or removed for the season) are left out.
- Round `lat` and `lon` to about 4 decimals (11 m): every distinct URL is its own CDN cache entry.
- Errors: 400 (missing or invalid `lat`, `lon`, `n`), 401 (token), 502 (Citi Bike down).

### `GET /citibike/station?id=<id>`

One station, by an `id` from `/citibike/nearby`, for favorites:
`{ "updatedAt": 1794322409, "station": { ... } }`, the same station object without `distance`.
An unknown id, or a station no longer on the street, is a 404.

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

The `Authorization` header is ignored: a token sent there is a 401.

The server reads the token from the `TRANSIT_TOKEN` environment variable (set in Vercel only,
never committed). It may hold several comma-separated tokens, for rotation: add the new one,
update clients, remove the old one. If it's unset, authenticated routes answer 500.

## Caching

| Route | `Cache-Control` |
| --- | --- |
| `/subway/arrivals` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/subway/arrivals` with failed feeds | `public, s-maxage=5` |
| `/preview/subway` | `public, max-age=20, s-maxage=20, stale-while-revalidate=40` (`public, max-age=5, s-maxage=5` with failed feeds) |
| `/path/arrivals` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/preview/path` | `public, max-age=20, s-maxage=20, stale-while-revalidate=40` |
| `/subway/vehicles`, `/<agency>/arrivals`, `/<agency>/vehicles` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/preview/lirr`, `/preview/mnr`, `/preview/ferry`, `/preview/bus` | `public, max-age=20, s-maxage=20, stale-while-revalidate=40` |
| `/bus/arrivals` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/subway/alerts`, `/<agency>/alerts`, `/bus/alerts` | `public, s-maxage=60, stale-while-revalidate=120` |
| `/citibike/station`, `/citibike/nearby` | `public, s-maxage=20, stale-while-revalidate=40` |
| `/stops/search`, `/path/stations`, `/<agency>/stations` | `public, s-maxage=3600, stale-while-revalidate=86400` (static data only changes with a deploy, and Vercel purges the CDN cache on each production deploy) |
| `/health`, errors | `no-store` |

So the CDN calls the function about once per 20 s per distinct URL. Behind it, each function
instance keeps decoded feeds in memory for 15 s and coalesces concurrent fetches, so different
stops on the same line within a window share one MTA request. `x-vercel-cache` on a response
tells whether the CDN served it (`HIT`, `STALE`) or not (`MISS`).

## Data

- **Real time**: the MTA subway GTFS-realtime feeds (no API key), one per line group (see
  `FEEDS` in `src/subway/feeds.ts`), decoded with `gtfs-realtime-bindings`. A request fetches,
  in parallel, only the feeds carrying routes scheduled at the requested stop.
- **Citi Bike**: the GBFS feeds `station_information` and `station_status` (plain JSON, no key,
  see `src/citibike/feeds.ts`), joined when either changes. Each function instance keeps the
  status for 15 s and the station list for 10 minutes; if refreshing the station list fails, the
  previous copy is used for up to 6 hours (retried every 10 minutes), then requests are 502s.
  There is no static Citi Bike data in the repo.
- **Static**: the MTA static subway GTFS is preprocessed by `scripts/build-static.ts` into
  `src/data/subway.generated.ts` (routes with colors, parent stops with the routes serving them,
  and station complexes built from in-station transfers in `transfers.txt`). The file is
  committed, so builds and tests don't depend on the MTA. The **Refresh static GTFS** workflow
  regenerates it daily and commits it when it changed, which triggers a Vercel deploy. (A Vercel
  Cron job can't do this: it runs a function, and a function can't change the deployed bundle.)

- **PATH**: the Port Authority's real-time JSON feed, the one behind the arrival boards on
  panynj.gov (`https://www.panynj.gov/bin/portauthority/ridepath.json`, no API key): one document
  with every station's next trains, refreshed about once a minute, so one upstream request
  (kept 15 s per function instance) answers every station. It carries no route ids, only line
  colors, which `src/path/stations.ts` maps to routes; the station list lives there too, since
  PATH has 13 stations and they don't change.

- **Alerts**: the MTA's GTFS-realtime alert feeds (`camsys/subway-alerts`, `bus-alerts`,
  `lirr-alerts`, `mnr-alerts`, no key) on the same host as the subway feeds.
- **LIRR and Metro-North**: the MTA's GTFS-realtime feeds (`lirr/gtfs-lirr`, `mnr/gtfs-mnr`, no
  key), with stations and branches from each railroad's static GTFS.
- **NYC Ferry**: the GTFS-realtime feeds and static GTFS at `nycferry.connexionz.net` (no key).
  Its static data keeps every scheduled trip, because the realtime feed names only a trip id and
  its next stop.
- The LIRR, Metro-North and ferry data files (`src/data/<agency>.generated.ts`) are built and
  refreshed like the subway's, by the same script and workflow.
- **Buses**: MTA Bus Time's SIRI StopMonitoring API (`bustime.mta.info`), one request per stop,
  which needs a free API key (`BUSTIME_KEY`, see Deploying). Its answer names the stop and each
  bus's destination, so the only static bus data is `src/data/bus.generated.ts`: route names and
  colors from the six static bus GTFS feeds (one per borough and MTA Bus Company), built and
  refreshed like the others. Each function instance keeps a stop's answer for 15 s.

## Development

```sh
pnpm install
pnpm test             # unit tests (recorded feeds in test/fixtures)
pnpm check            # every check CI runs: format, lint, types, unused code (knip), tests
pnpm format           # Prettier; a pre-commit hook also formats and lints staged files
pnpm build:static     # regenerate src/data/*.generated.ts (subway, lirr, mnr, ferry, bus)
pnpm build:openapi    # regenerate public/openapi.json after changing a route's schemas
pnpm record-fixtures  # re-record test/fixtures from the live feeds (or just `transit` / `citibike` / `bus`)
pnpm smoke            # check the live feeds (see below)
```

Layout:

```
api/                 Vercel functions (thin: they export GET from src/routes); api/agency.ts
                     serves every LIRR, Metro-North and ferry route, api/bus.ts, api/path.ts and
                     api/citibike.ts each their provider's routes
src/routes/          handlers: arrivals, search, preview, alerts, vehicles, path, agency, bus, health
src/subway/          feed list, arrivals computation, train positions, preview line
src/citibike/        Citi Bike: GBFS fetching, station join and nearest-station search
src/path/            PATH stations and routes, feed fetching and parsing, arrivals, preview line
src/agency/          LIRR, Metro-North and NYC Ferry: registry, departures, vehicle positions
src/bus/             buses: Bus Time (SIRI) fetching and parsing, arrivals
src/gtfsrt.ts        GTFS-realtime plumbing shared by every provider: fetch, decode, memo, helpers
src/alerts.ts        alerts in effect, from any GTFS-realtime alerts feed
src/preview.ts       the "next departure per destination" line shared by PATH and the agencies
src/stops/           station resolution and name search
src/static/          static GTFS preprocessing (pure) and its types
src/data/            generated static data
src/openapi.ts       the OpenAPI document, built from the routes' schemas
public/              static files: /docs (Scalar) and the generated openapi.json
scripts/             build-static, record-fixtures, smoke
test/                vitest tests and fixture feeds
vercel.json          rewrites the public paths to the functions
```

To run locally against Vercel's runtime, use `vercel dev` with `TRANSIT_TOKEN` in `.env.local`
(see `.env.example`).

## Deploying

1. Import the repo in Vercel (framework preset "Other", no build command needed).
2. Set `TRANSIT_TOKEN` in Project Settings, Environment Variables (Production and Preview).
   Generate one with `openssl rand -base64 32`.
3. Set `BUSTIME_KEY` the same way, to an MTA Bus Time API key (free, requested at
   `https://register.developer.obanyc.com/`). Without it `/bus/arrivals` and `/preview/bus` answer
   500; everything else works.
4. Deploy. Optionally add the repository secrets `TRANSIT_BASE_URL` (such as
   `https://transit-xyz.vercel.app`) and `TRANSIT_TOKEN` so the scheduled smoke test also checks
   the deployment, and `BUSTIME_KEY` so it checks Bus Time too.

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
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/preview/subway?q=bedford"   # 200, one line of text
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/path/arrivals?station=JSQ"  # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/path/stations"              # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/preview/path?q=grove"       # 200, one line of text
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/subway/alerts?route=A"      # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/subway/vehicles?route=L"    # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/lirr/arrivals?station=102"  # 200, Jamaica
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/mnr/stations?q=rye"         # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/preview/ferry?q=wall"       # 200, one line of text
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/bus/alerts?route=Q29"       # 200
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/bus/arrivals?stop=401687"  # 200 (500 without BUSTIME_KEY)
curl -i -H "X-Transit-Token: $TOKEN" "$BASE/citibike/nearby?lat=40.7559&lon=-73.9871"  # 200
```

Or run `TRANSIT_BASE_URL=$BASE TRANSIT_TOKEN=$TOKEN pnpm smoke`, which does the same checks.

## Testing

- `test/static-build.test.ts`: CSV parsing and the static GTFS preprocessing on a small GTFS
  sample, plus sanity checks on the committed data.
- `test/arrivals.test.ts`: arrivals on a hand-built protobuf feed (grouping, ordering, past and
  skipped stops, complexes, platforms) and on recorded feeds for all eight MTA feeds.
- `test/auth.test.ts`, `test/routes.test.ts`: the token check, status codes, `Cache-Control`
  and `Vary` headers, partial feed failures, search ranking, the preview route.
- `test/preview.test.ts`: the preview line's format on hand-built arrivals.
- `test/path.test.ts`: PATH station lookup, feed parsing (hand-built documents and a recorded
  feed), arrivals, the preview line and the three PATH routes.
- `test/agency.test.ts`: the generic static build, departures (including the ferry's schedule
  extension), vehicle positions, and every `/lirr`, `/mnr`, `/ferry` and `/bus` route on
  recorded feeds.
- `test/alerts.test.ts`: alerts in effect on hand-built and recorded feeds, `/subway/alerts`
  and `/subway/vehicles`.
- `test/bus.test.ts`: the static bus build, Bus Time parsing (a fixture answer and hand-built
  ones), arrivals ordering, and the bus routes, key handling included.
- `test/citibike.test.ts`: the station join and nearest-station search on hand-built feeds and
  on recorded GBFS feeds (trimmed to the stations around Times Sq), and both routes.
- `.github/workflows/smoke.yml`: twice a day against the live feeds. It fails on stale feeds,
  routes missing from `FEEDS`, many stop ids missing from the static data, or a big station with
  no arrivals; for PATH, on entries the parser can't read, unknown stations or line colors,
  stale data, or Journal Square with no trains; for the LIRR, Metro-North and the ferry, on
  stale feeds, ids missing from the static data, a main stop with no departures or no vehicle
  positions; for Citi Bike, on feeds that are stale or no longer join; for buses (with
  `BUSTIME_KEY`), on a changed or stale Bus Time answer, unknown routes or no buses at 1 Av/E 14
  St; and on alert feeds that stop decoding.

## Roadmap

Not built yet. Each new source follows the subway's conventions: token in a header,
`Cache-Control: s-maxage` for the CDN, times as epoch seconds, names joined in,
fixture-based parsing tests and a scheduled smoke test against the live feed.
In code, that means one function for the provider, `api/<provider>.ts` (Vercel's Hobby plan
allows 12 and there are 10), with its routes dispatched by `byOp()`, handlers in `src/routes/`
wrapped in `authenticated(...)`, and the `LIVE_CACHE` or `STATIC_CACHE` headers from `src/http.ts`.

- **Bus stops**: search by name and nearby stops for `/bus/arrivals`, which today takes the code
  on the stop's sign. Needs the static bus stops (about 13,500) in the bus function, or Bus
  Time's stops API.
- **Bus positions**: `/bus/vehicles?route=`, from Bus Time's vehicle monitoring.
- **NJ Transit**: rail and bus arrivals. Source: NJ Transit's GTFS-realtime feeds, which need a
  developer account.
- **Alert categories and track numbers**: both sit in MTA extensions to GTFS-realtime that
  `gtfs-realtime-bindings` drops; decoding them needs the MTA's `.proto` files.
- **Stop search across systems**: extend `/stops/search` to PATH, LIRR, Metro-North and ferry
  stations (today each has its own list) and Citi Bike stations.

## Clients

Clients send `X-Transit-Token` (not `Authorization`) so their calls are CDN-cacheable. Favorite
stops live in each client; the service is stateless. For alfresco (Swift), the base URL and token
are read like `Config.weatherAPIKey()`, and a nil token turns the feature off. alfresco also sends
the token with a workflow's `preview` request when the preview URL is on this service's host
(`/preview/...`), and keeps the line for the response's `max-age`.
