# AGENTS.md

Guidance for coding agents working in this repository. The README has the public API, response
shapes and deployment steps; this file covers what you need to change the code safely.

## Commands

```sh
pnpm test                            # vitest, all tests (offline: uses test/fixtures)
pnpm vitest run test/routes.test.ts  # one file
pnpm vitest run -t "caps limit"      # tests whose name matches
pnpm typecheck                       # tsc --noEmit over api, src, scripts, test
pnpm build:static                    # regenerate every src/data/*.generated.ts (subway, lirr, mnr, ferry)
pnpm build:static lirr               # one of them
pnpm build:static ferry path/to.zip  # one of them, from a local zip (a bare zip path means the subway)
pnpm record-fixtures                 # re-record test/fixtures from the live feeds
pnpm record-fixtures citibike        # only the Citi Bike feeds (`transit`: only everything else)
pnpm smoke                           # live feed checks, Citi Bike included (+ deployment checks if TRANSIT_BASE_URL is set)
```

There is no lint step and no build step: Vercel compiles `api/**/*.ts` itself. To check what
Vercel will produce, `pnpm dlx vercel build` works offline with a stub `.vercel/project.json`
(`{"projectId":"x","orgId":"y","settings":{"framework":null}}`); `.vercel/` is gitignored.

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

PATH (`/path/arrivals`, `/path/stations`, `/preview/path`) has the same shape with less machinery:
`src/routes/path.ts` resolves the station (`src/path/stations.ts`, a hand-written table: 13
stations and 5 routes, no generated data), `fetchPathFeed()` (`src/path/feed.ts`) fetches the one
JSON document through the same 15 s memo (`memoized()`) and normalizes it with `parsePathFeed()`, and
`computePathArrivals()` (`src/path/arrivals.ts`, pure) groups trains by route and direction.

The LIRR, Metro-North and NYC Ferry share one implementation, driven by the `AGENCIES` table in
`src/agency/agencies.ts` (feeds, static data, whether a stop is a `station` or a `stop`):

- `api/agency.ts` is a single function for all of their routes and `/bus/alerts`. `vercel.json`
  rewrites `/lirr/arrivals` to `/api/agency?agency=lirr&op=arrivals`, and `agencyRoute()` in
  `src/routes/agency.ts` reads the agency and operation from the public path or, failing that,
  from those query parameters, so it does not depend on which URL the platform passes. One
  function because Vercel has capped functions per deployment on the Hobby plan (12 when last
  checked; there are 11 now): add operations to `OPS` rather than new files under `api/`.
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
- Adding an agency whose realtime feed is plain GTFS-realtime with its own static GTFS is a row
  in `AGENCIES`, a source in `scripts/build-static.ts`, entries in `vercel.json`, and a
  `MAIN_STOP` in `scripts/smoke.ts`; the fixture recorder and the tests' fetcher follow `AGENCIES`.

Citi Bike (`/citibike/station`, `/citibike/nearby`, both in `src/routes/citibike.ts`) has no
static data and no GTFS: `fetchGbfs()` (`src/citibike/feeds.ts`) fetches the GBFS `station_information`
and `station_status` JSON through `memoized()` with a per-feed TTL (10 min and 15 s), and
`joinStations()` (`src/citibike/stations.ts`, pure) joins them. Both feeds are required: a failing
`station_status` is a 502. A failing `station_information` falls back to the last copy that loaded
(`staleOnError`), for up to `STALE_MAX_MS`, then is a 502 too. Both routes are one function,
`api/citibike.ts`, behind a rewrite like the agencies' (`citibikeHandler()` reads the `op`).

### Static data

`src/data/subway.generated.ts` is generated by `scripts/build-static.ts` (I/O) from
`src/static/build.ts` (pure, takes file texts) and committed; `lirr`, `mnr` and
`ferry.generated.ts` come from the same script through `src/static/agency.ts`. Do not edit them
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
- ESM with `NodeNext` resolution: imports end in `.js` even though the files are `.ts`. Import
  anything in `src/` from another folder through the `#src/*` alias (`#src/http.js`), and use
  `./` within a folder. The alias is Node's own `imports` field in `package.json`, not tsconfig
  `paths`: Vercel compiles each file without rewriting its imports, so only an alias Node
  resolves at runtime works once deployed. Imports of `test/` or `api/` stay relative.
- TypeScript is pinned to 5.9: Vercel's build reported type errors with TypeScript 7.
- Toolchain: Node 26 (`engines` in `package.json`, `node-version` in the workflows) and pnpm, pinned
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
- New providers (see the README roadmap) that don't fit `AGENCIES` go under `api/<provider>/`
  with a handler in `src/routes/` (mind the function count above), fixture-based parsing tests, and a check in `scripts/smoke.ts`. Upstream keys
  belong in Vercel environment variables.
