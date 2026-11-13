# AGENTS.md

Guidance for coding agents working in this repository. The README has the public API, response
shapes and deployment steps; this file covers what you need to change the code safely.

## Commands

```sh
pnpm test                            # vitest, all tests (offline: uses test/fixtures)
pnpm vitest run test/routes.test.ts  # one file
pnpm vitest run -t "caps limit"      # tests whose name matches
pnpm typecheck                       # tsc --noEmit over api, src, scripts, test
pnpm lint                            # eslint (eslint.config.js)
pnpm format                          # prettier over the code, JSON and YAML (`format:check` only reports)
pnpm knip                            # unused files, exports and dependencies
pnpm check                           # all of the above and the tests, as CI runs them
pnpm build:openapi                   # regenerate public/openapi.json from the route schemas (src/openapi.ts)
pnpm build:static                    # regenerate every src/data/*.generated.ts (subway, lirr, mnr, ferry, bus)
pnpm build:static lirr               # one of them
pnpm build:static ferry path/to.zip  # one of them, from a local zip (a bare zip path means the subway)
pnpm record-fixtures                 # re-record test/fixtures from the live feeds
pnpm record-fixtures citibike        # only the Citi Bike feeds (`bus`: Bus Time, needs BUSTIME_KEY; `transit`: the rest)
pnpm smoke                           # live feed checks, Citi Bike included (+ deployment checks if TRANSIT_BASE_URL is set)
```

Style is Prettier's (`.prettierrc.json`; Markdown is skipped because its prose is wrapped by hand),
and ESLint (`eslint.config.js`) turns the import rules below into errors. A pre-commit hook
(`.husky/pre-commit`, through lint-staged) runs both on staged files; CI runs `pnpm check`. A
reformat that touches many lines goes in its own commit, listed in `.git-blame-ignore-revs`.

There is no build step: Vercel compiles `api/**/*.ts` itself and serves `public/` as static files
(`outputDirectory` in `vercel.json`; without it, Vercel serves the whole repository). To check what
Vercel will produce, `pnpm dlx vercel build` works offline with a stub `.vercel/project.json`
(`{"projectId":"x","orgId":"y","settings":{"framework":null}}`); `.vercel/` is gitignored. Delete
`.vercel/output` afterwards: vitest picks up the test files copied into it.

Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a proxy (such as a cloud sandbox), run the
scripts that hit the network with `NODE_USE_ENV_PROXY=1` (Node 22.21 or later, including Node 26).

## Architecture

Request flow for `/subway/arrivals`:

1. `vercel.json` rewrites `/subway/arrivals` to `api/subway/arrivals.ts`. Files in `api/` are
   one-liners exporting `GET` (Web `Request` to `Response` signature) built by a factory in `src/routes/`.
2. `authenticated()` in `src/http.ts` checks the token (`src/auth.ts`), runs the handler, turns
   thrown errors into 500, and appends `Vary: x-transit-token` to every response.
3. `StationIndex.resolve()` (`src/stops/stations.ts`) maps the `stop` param (station id, parent
   stop id or platform id) to platform ids and the routes scheduled there.
4. `feedsForRoutes()` picks the GTFS-realtime feeds for those routes (`FEEDS` in
   `src/subway/feeds.ts`); `fetchFeed()` (`src/gtfsrt.ts`) fetches them in parallel through a
   15 s per-instance memo.
5. `computeArrivals()` (`src/subway/arrivals.ts`, pure) groups stop time updates by route and
   direction. It takes decoded feeds and `now`, so tests drive it without the network.

Route factories take their dependencies (`fetcher`, `now`, `index`) as arguments; tests inject a
fixture fetcher and a fixed clock (`test/helpers.ts`) instead of mocking modules.

PATH (`/path/arrivals`, `/path/stations`, `/preview/path`) has the same shape with less machinery,
in one function (`api/path.ts`, behind rewrites like the agencies'): `src/routes/path.ts`
resolves the station (`src/path/stations.ts`, a hand-written table: 13 stations and 5 routes, no
generated data), `fetchPathFeed()` (`src/path/feed.ts`) fetches the one
JSON document through the same 15 s memo (`memoized()`) and normalizes it with `parsePathFeed()`, and
`computePathArrivals()` (`src/path/arrivals.ts`, pure) groups trains by route and direction.

The LIRR, Metro-North and NYC Ferry share one implementation, driven by the `AGENCIES` table in
`src/agency/agencies.ts` (feeds, static data, whether a stop is a `station` or a `stop`):

- `api/agency.ts` is a single function for all of their routes. `vercel.json`
  rewrites `/lirr/arrivals` to `/api/agency?agency=lirr&op=arrivals`, and `agencyRoute()` in
  `src/routes/agency.ts` reads the agency and operation from the public path or, failing that,
  from those query parameters, so it does not depend on which URL the platform passes.
- Vercel's Hobby plan caps a deployment at 12 functions when they are plain files under `api/`;
  there are 10 now, and `test/bundles.test.ts` fails past 12. Group a provider's routes in one
  function: `byOp()` in `src/http.ts` dispatches on the operation (`/path/stations` or the
  rewrite's `/api/path?op=stations`, `/preview/path` as `preview`), as `api/path.ts`,
  `api/bus.ts` and `api/citibike.ts` do. Add an operation rather than a file under `api/`.
- `computeAgencyArrivals()` (`src/agency/arrivals.ts`, pure) returns one flat list of departures.
  When the static data has `trips` (the ferry), stops the feed doesn't predict are scheduled
  from the last predicted stop.
- `computeAgencyVehicles()` (`src/agency/vehicles.ts`) and `computeAlerts()` (`src/alerts.ts`,
  also behind `/subway/alerts`) are pure too.
- `src/gtfsrt.ts` holds what every GTFS-realtime provider shares: `fetchFeed()` (a subway feed
  name, an MTA `group/feed` name, or a full URL), `tryFetchFeed()` for routes that answer 502 on
  failure, the memo, `num()`, `terminalName()`, `fallbackRoute()`. Provider folders import from
  it, not from each other.
- Each function bundles what it imports: `src/routes/agency.ts` must not import the subway's
  station index (155 KiB of data), and subway routes must not import `src/agency/agencies.ts`.
  `test/bundles.test.ts` walks each function's imports, indirect ones included, and fails when a
  large module reaches a function not allowed to bundle it; list a new large module there. ESLint
  checks that provider folders don't import each other (`eslint.config.js`).
- Adding an agency whose realtime feed is plain GTFS-realtime with its own static GTFS is a row
  in `AGENCIES`, a source in `scripts/build-static.ts`, entries in `vercel.json`, and a
  `MAIN_STOP` in `scripts/smoke.ts`; the fixture recorder and the tests' fetcher follow `AGENCIES`.

Buses (`/bus/arrivals`, `/preview/bus`, `/bus/alerts`, `/bus/vehicles`, `/bus/nearby`) are not an
agency: they are their own function, `api/bus.ts` (`busHandler()` in `src/routes/bus.ts`). Arrivals
come from MTA Bus Time's SIRI StopMonitoring API, one JSON request per stop (`fetchStopMonitoring()`
in `src/bus/siri.ts`, through `memoized()`), read by `parseStopMonitoring()` and ordered by
`computeBusArrivals()` (both pure). Positions come from SIRI VehicleMonitoring, one request per route
(`fetchVehicleMonitoring()`, `computeBusVehicles()` in `src/bus/vehicles.ts`), and nearby stops from
Bus Time's OneBusAway "Discovery" API on `bustime-classic.mta.info` (`src/bus/stops.ts`), which
serves the static stop data so the function doesn't bundle it. The
answer names the stop and destinations, so the only static data is route names and colors
(`src/data/bus.generated.ts`, from six zips, built by `src/static/bus.ts`). The key is
`BUSTIME_KEY` (a Vercel environment variable); without it those two routes answer 500. It goes in
the query string, so no error, log or fixture may carry the request URL. Bus stop data (about
13,500 stops) would be the bus function's to bundle: keep it out of the others.

Citi Bike (`/citibike/station`, `/citibike/nearby`, both in `src/routes/citibike.ts`) has no
static data and no GTFS: `fetchGbfs()` (`src/citibike/feeds.ts`) fetches the GBFS `station_information`
and `station_status` JSON through `memoized()` with a per-feed TTL (10 min and 15 s), and
`joinStations()` (`src/citibike/stations.ts`, pure) joins them. Both feeds are required: a failing
`station_status` is a 502. A failing `station_information` falls back to the last copy that loaded
(`staleOnError`), for up to `STALE_MAX_MS`, then is a 502 too. Both routes are one function,
`api/citibike.ts`, behind a rewrite like the agencies' (`citibikeHandler()`, through `byOp()`).

### Static data

`src/data/subway.generated.ts` is generated by `scripts/build-static.ts` (I/O) from
`src/static/build.ts` (pure, takes file texts) and committed; `lirr`, `mnr` and
`ferry.generated.ts` come from the same script through `src/static/agency.ts`. It also writes
`subway.version.generated.ts`, the feed version alone, so `/health` doesn't bundle the data. Do not edit them
by hand; change the build and regenerate. Output must stay deterministic (sorted keys, no timestamps) because the
daily `refresh-static.yml` workflow commits only when the file changes, and each commit deploys.

Ids, which clients store as favorites, so keep them stable:

- Parent stop: the GTFS `stop_id` (`127`). Platforms are the parent id plus `N` or `S`.
- Station: member stop ids sorted and joined with `+` (`127+725+902+A27+R16`); a stop in no
  complex is its own station with its stop id. Complexes are connected components of
  `transfers.txt` links between different parent stops.

### MTA feed quirks handled in code

- Protobuf `int64` fields decode as `Long` objects; convert with the `num()` helper in
  `src/gtfsrt.ts`.
- Trips can end at yard or non-revenue stop ids absent from the static data; the headsign walks
  back to the last known stop (`terminalName`).
- Diamond express routes (`6X`, `7X`, `FX`) are distinct route ids in both feeds and static data.
  Search hides them next to their base route; arrivals keep them.
- Each realtime route must appear in `FEEDS`. A test checks every static route is covered, and the
  smoke test fails if a live feed carries a route `FEEDS` does not list.

### Citi Bike feed quirks handled in code

- `num_bikes_available` includes e-bikes; classic bikes are the difference with
  `num_ebikes_available`. `vehicle_types_available` doesn't always add up to the total, so it
  isn't used.
- Booleans are `0`/`1`. Stations with `is_installed: 0` are listed in both feeds with zero counts
  and a placeholder `last_reported`; the join drops them. A missing `is_installed` reads as
  installed and a missing `is_renting` or `is_returning` as false.
- `parseGbfs()` drops entries without a station id and rejects a feed with no stations, so neither
  is memoized or becomes the copy served while a refresh fails.
- Station ids are opaque strings (UUIDs or long digit strings) that clients store as favorites.

### PATH feed quirks handled in code

- `secondsToArrival` counts from the message's own `lastUpdated`, not from the request: the
  document can be a minute or two old. The arrival time is their sum.
- A train at the platform reads 0 seconds for as long as it stands there, so its computed time
  slips into the past. `BOARDING_GRACE_S` keeps it listed for 2 minutes; previews clamp to 0.
- There are no route ids, only `lineColor`, with two comma-separated colors for the night and
  weekend line via Hoboken. `colorsKey()` normalizes it and `routeForColors()` finds the route;
  an unknown color still shows, as a route named `PATH`, and fails the smoke test.
- The parser counts entries it can't read (`skipped`) instead of throwing, so one odd message
  doesn't take a station down. The smoke test fails when the count isn't 0.
- Station ids are the feed's codes (`09S`, not `9S`). Clients store them: keep them stable.

### Bus Time quirks handled in code

- Line refs carry the operator (`MTA NYCT_M15+`, `MTABC_Q06`); without it they are the static
  GTFS route ids, which the alerts feed uses too. Select Bus Service routes end in `+` and show as
  `M15-SBS`. Stop refs are `MTA_` and the six-digit code on the stop's sign; the route accepts both.
- An unknown stop is a 200 with an `ErrorCondition` (`No such stop: MTA_999999.`), answered as
  404. The smoke test checks that text still comes back.
- A bus at its terminal (`ProgressStatus` `layover` or `prevTrip`) often has no expected time;
  it is listed after the timed ones with `time: null`.
- Names and statuses can be a string or a list of strings. Distances are `MonitoredCall` fields in
  SIRI 2 (requested with `version=2`) and `Extensions.Distances` in SIRI 1; the parser reads both.
- The detail level decides which fields come back: StopMonitoring's `minimum` leaves out
  `LineRef`, `FramedVehicleJourneyRef` and `StopPointName`, so the request asks for `basic`;
  VehicleMonitoring asks for `normal`, the first level with the next stop's `StopPointRef`.
- VehicleMonitoring with `version=2` redirects (302) to `vehicle-monitoring-v2.json`; `fetch`
  follows it. Its `LineRef` takes the plain GTFS route id (`M15+`), operator optional.
- Cancelled trips come only on the `/api/2/siri/` path, as `VehicleStatus: cancelled` (SIRI 2) or
  `ArrivalStatus`/`DepartureStatus: cancelled` on the call (SIRI 1), at their `AimedArrivalTime`.
  None was running when the fixtures were recorded, so the tests build them by hand from the
  documented format.
- `Bearing` counts counterclockwise from east; responses carry a compass `heading`.
- The Discovery API answers a bad key with a 200 and a body of `null`: `parseStopsForLocation()`
  throws on anything but `code: 200` with a stop list, so it is a 502 and not memoized.
- test/fixtures/bustime-*.json are real answers, recorded late in the evening (`pnpm record-fixtures
  bus`); after re-recording, update `BUS_FIXTURE_NOW_MS` in `test/helpers.ts`, and the counts and
  names `test/bus.test.ts` expects.

### Other feed quirks handled in code

- LIRR and Metro-North keep finished trips and their vehicles in the feed for hours: past stop
  times are dropped, and so are positions older than `VEHICLE_MAX_AGE_S`.
- Metro-North puts a trip's update and its vehicle in one entity, and the vehicle names the
  entity id (the train number) as its trip id; its trip ids don't match its static GTFS. LIRR
  uses separate entities joined by trip id. `computeAgencyVehicles()` handles both.
- Protobuf fields that are absent read as their default (`delay` 0, `currentStatus`
  `IN_TRANSIT_TO`); where absence matters the code checks `Object.hasOwn`.
- NYC Ferry trip updates have a trip id and the next stop, nothing else: route, headsign and
  later stops come from the static trips, so its static data must be current (trip ids change
  with the schedule; the smoke test fails when many feed trips are unknown). Ferry headsigns
  are the last stop's name, because `trip_headsign` spells the same landing several ways.
- Alert texts come in `en` and `en-html`; `computeAlerts()` returns the plain one. Planned work
  carries one active period per affected night, hundreds in all, which is why the recorded
  alert fixtures are cut down to what was in effect.
- The MTA extends GTFS-realtime: `gtfs-realtime-NYCT.proto` (subway trips), `-MTARR.proto`
  (railroad stop times), `-service-status.proto` (alerts). The bindings don't decode them but
  keep their bytes in `$unknowns` (protobufjs 8, written back on encode, so recorded fixtures
  keep them); `extension()` in `src/protowire.ts` reads them from there, and tests add them with
  `extensionField()` and `withExtension()` (`test/feed.ts`). A broken extension reads as absent.
- Subway trips (`src/subway/nyct.ts`): `is_assigned` is false for trips listed before a train
  leaves the terminal. The first character of `train_id` is the trip type (`=` reroute, `/`
  skip-stop, `$` short turn), as documented for the 1-6 lines. B Division ids start with other,
  undocumented codes, so only those three characters are read, for every trip; anything else is
  `change: null`. A vehicle's timestamp is when the train last moved:
  over `STALLED_AFTER_S` (90 s) before the header, it is stalled and its predictions are frozen.
  Trip feeds also carry "Train delayed" alerts naming trips.
- Railroad stop times (`src/agency/mtarr.ts`): `track` on both, `trainStatus` on Metro-North only
  (the LIRR sends it empty).
- MTA alerts carry their status (`Delays`, `Planned - Stops Skipped`) in
  `MercuryAlert.alert_type`, which `alertType()` in `src/mercury.ts` reads. Ranks come from the MTA's table (`ALERT_STATUSES`, documented in
  `nymta/gtfs-documentation`); the smoke test fails on a status the table lacks.
- Alert entity ids end in the status rank (`lmm:alert:276100:26`), planned work ids don't. An
  alert whose parts have different statuses comes as one entity per status with the same id
  before the rank; `computeAlerts()` drops the rank and merges them.
- Subway alerts can name one entity per station, with `direction_id` 0 for northbound and 1 for
  southbound (or a platform id). Other agencies' `direction_id`s have no documented meaning in
  alerts and aren't shown.
- Alerts can name route ids the static data lacks (Metro-North's west-of-Hudson lines): they
  show under their id.

## Conventions that are easy to break

- Auth is `X-Transit-Token`, not `Authorization`: Vercel's CDN never caches requests with an
  `Authorization` header. Every authenticated response must keep `Vary: x-transit-token`
  (added by `authenticated()`), or a cached 200 could be served to a request without the token.
- Errors and `/health` are `no-store`. Success uses `LIVE_CACHE` (arrivals, vehicles),
  `ALERTS_CACHE` or `STATIC_CACHE` (data that only changes with a deploy) from `src/http.ts`. Never set cookies on cached routes.
- Times are epoch seconds; responses carry names and colors, not ids alone.
- `/preview/...` routes answer one line of `text/plain` through `text()` in `src/http.ts` (never
  empty, never starting with `<`, well under 1 KB: alfresco reads only the first 1 KB and drops
  HTML), with `PREVIEW_CACHE`, whose `max-age` is how long the client keeps the line. Their
  errors stay JSON and `no-store`. The line's format is built by a pure function with its own
  tests (`src/subway/preview.ts`, and `src/preview.ts` for PATH and the agencies).
- Every route has request and response schemas (zod): `schemas.ts` in each provider folder, and
  the shared pieces (routes, alerts, `/health`, parameter helpers) in `src/schema.ts`. The schema
  is the definition: types are `z.infer`red from it, it reads the query (`parseQuery()`, which
  keeps the error messages clients see), and the tests check real responses against it
  (`test/responses.test.ts` sends a request to every documented route and fails for a route
  without one). Response objects are `z.strictObject`, so a field added in code but not in the
  schema fails the tests. Response schemas run in tests only, never per request. Pure modules
  import only their types (`import type`), so the smoke test and the data scripts don't load zod.
  Build parameters with `requiredParam()`, `optionalParam()` (blank reads as absent; both take a
  maximum length, 100 for search text), `countParam()` and `coordinateParam()`, which keep the
  API's messages (`stop is required`, `q is too long`). Rules across parameters (`q or stop is
  required`) are a `.refine()` on the query object. Agency schemas name the stop `station` or
  `stop` (`STOP_SCHEMAS` in `src/agency/schemas.ts`) and their queries hand it to the handler as
  `stop`. Descriptions go in `.meta()`: they become the API docs. Each route has an entry in
  `ROUTES` (`src/openapi.ts`; the agency routes come from `AGENCIES`), each response schema a name
  in `NAMED`; `pnpm build:openapi` then rewrites `public/openapi.json`, which `/docs` renders
  (Scalar, pinned on a CDN), and a test fails while the committed file is out of date.
- ESM with `NodeNext` resolution and `verbatimModuleSyntax`: imports end in `.js` even though the
  files are `.ts`, and type-only imports say so (`import type`, or `type` inline), since Vercel
  compiles each file on its own. Import anything in `src/` from another folder through the
  `#src/*` alias (`#src/http.js`), and use `./` within a folder. The alias is Node's own `imports`
  field in `package.json`, not tsconfig `paths`: Vercel compiles each file without rewriting its
  imports, so only an alias Node resolves at runtime works once deployed. Imports of `test/` or
  `api/` stay relative.
- TypeScript is pinned to 5.9: Vercel's build reported type errors with TypeScript 7.
- Toolchain: Node 26 (`engines` in `package.json`, which Vercel and the workflows read) and pnpm, pinned
  by `packageManager`. Vercel picks a pnpm version from the lockfile format rather than
  `packageManager`, so `installCommand` in `vercel.json` pins the same version: bump both together.
  Node 26 ships without Corepack; CI installs pnpm with `pnpm/action-setup`, which reads `packageManager`.
- pnpm refuses to install when a dependency's build script hasn't been approved. Approvals live in
  `allowBuilds` in `pnpm-workspace.yaml` (`pnpm approve-builds <pkg>` edits it).
- On Node 26, `fetch` can use HTTP/2, where `statusText` is empty: check `res.status` only.
- After `pnpm record-fixtures` (or `pnpm record-fixtures transit`), update `FIXTURE_NOW_MS` in `test/helpers.ts` to the newest feed
  header timestamp it prints, or the fixture tests will see every train as already gone. It
  records every GTFS-realtime feed at once (subway, LIRR, Metro-North, ferry, alerts), so they
  share that clock, and the PATH feed too: set `PATH_FIXTURE_NOW_MS` to the newest update it prints. Tests on recordings assert shapes and
  invariants, not the trains of one recording, so a re-record should not need test changes. If the static data
  changed, regenerate it before recording so stop ids match. The Citi Bike fixtures
  (`pnpm record-fixtures citibike`) are the live feeds trimmed to the stations around Times Sq;
  after re-recording them, update the counts and names that `test/citibike.test.ts` expects.
- New providers (see the README roadmap) that don't fit `AGENCIES` get one function,
  `api/<provider>.ts`, with its routes dispatched by `byOp()` from a handler in `src/routes/` (mind the function count above), fixture-based parsing tests, and a check in `scripts/smoke.ts`. Upstream keys
  belong in Vercel environment variables.
