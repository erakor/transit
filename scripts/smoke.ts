/**
 * Smoke test against the live feeds (and, optionally, a deployment).
 *
 *   pnpm smoke
 *   TRANSIT_BASE_URL=https://<deployment> TRANSIT_TOKEN=... pnpm smoke
 *
 * Fails when an upstream change would break the service: a feed that no longer decodes, stale
 * data, routes the FEEDS table doesn't know, stop ids missing from the static data, or a big
 * station with no arrivals. For PATH: entries the parser can't read, stations or line colors it
 * doesn't know, stale data, or Journal Square with no trains. For LIRR, Metro-North and NYC
 * Ferry: stale or empty feeds, stop or route ids missing from the static data, ferry trips missing
 * from the static schedule, a main stop with no departures, or no vehicle positions. For alerts:
 * a feed that no longer decodes or has gone a day without an update, alerts without a status, or
 * statuses missing from the MTA's table. For Citi Bike: a feed that
 * changed shape, stale status, no bikes, e-bikes or free docks anywhere, or no station within
 * 500 m of Times Sq. For buses, when BUSTIME_KEY is set: a Bus Time answer that changed shape or
 * is stale, routes missing from the static bus data, no bus on its way to 1 Av/E 14 St, an
 * unknown stop or route no longer answered as one, no M15 positions, or a stop lookup that doesn't
 * find 1 Av/E 14 St at its own position.
 */
import { AGENCIES } from '#src/agency/agencies.js'
import { computeAgencyArrivals } from '#src/agency/arrivals.js'
import { computeAgencyVehicles } from '#src/agency/vehicles.js'
import { computeAlerts } from '#src/alerts.js'
import { alertType, statusRank } from '#src/mercury.js'
import { fetchStopMonitoring, fetchVehicleMonitoring } from '#src/bus/siri.js'
import { fetchStopsForLocation } from '#src/bus/stops.js'
import { fetchGbfs } from '#src/citibike/feeds.js'
import { joinStations, nearestStations } from '#src/citibike/stations.js'
import { BUS_DATA } from '#src/data/bus.generated.js'
import { fetchFeed, type FeedMessage } from '#src/gtfsrt.js'
import { computePathArrivals } from '#src/path/arrivals.js'
import { fetchPathFeed } from '#src/path/feed.js'
import { PATH_STATIONS, pathStation, routeForColors } from '#src/path/stations.js'
import { BUS_ALERTS_FEED, NEARBY_RADIUS_M } from '#src/routes/bus.js'
import { SUBWAY_ALERTS_FEED } from '#src/routes/alerts.js'
import { stationIndex } from '#src/stops/stations.js'
import { computeArrivals } from '#src/subway/arrivals.js'
import { FEEDS } from '#src/subway/feeds.js'
import { BUS_STOP, BUS_STOP_POINT, TIMES_SQ } from '../test/helpers.js'

const problems: string[] = []
const fail = (msg: string) => {
  problems.push(msg)
  console.error(`FAIL ${msg}`)
}
const nowS = Math.floor(Date.now() / 1000)
const index = stationIndex()

/** Every feed is fetched up front, in parallel; a failure is reported where the feed is checked. */
const live = (feed: string) => fetchFeed(feed, { timeoutMs: 20_000 }).catch((err: Error) => err)
const agencies = Object.values(AGENCIES)
const alertFeeds = [SUBWAY_ALERTS_FEED, BUS_ALERTS_FEED, ...agencies.map(a => a.alertsFeed)]
const fetched = new Map<string, FeedMessage | Error>()
await Promise.all(
  [...Object.keys(FEEDS), ...agencies.flatMap(a => [a.tripsFeed, a.vehiclesFeed ?? a.tripsFeed]), ...alertFeeds].map(
    async feed => {
      if (!fetched.has(feed)) fetched.set(feed, await live(feed))
    }
  )
)
/** The fetched feed, or undefined after reporting why it is missing. */
function feedOrFail(label: string, feed: string): FeedMessage | undefined {
  const f = fetched.get(feed)!
  if (f instanceof Error) fail(`${label}: ${f.message}`)
  return f instanceof Error ? undefined : f
}

/** The checks every trip updates feed gets. Returns its trips. */
function checkTripFeed(label: string, feed: FeedMessage, knownStop: (id: string) => boolean, extra = '') {
  const ts = Number(feed.header.timestamp ?? 0)
  const trips = feed.entity.flatMap(e => (e.tripUpdate ? [e.tripUpdate] : []))
  const stopIds = trips.flatMap(t => (t.stopTimeUpdate ?? []).map(s => s.stopId ?? ''))
  const unknownStops = stopIds.filter(s => !knownStop(s))
  console.log(
    `${label}: ${trips.length} trips, age ${nowS - ts}s, ${unknownStops.length}/${stopIds.length} stop updates with unknown stop ids${extra}`
  )
  if (Math.abs(nowS - ts) > 600) fail(`${label}: header timestamp ${ts} is ${nowS - ts}s old`)
  if (trips.length === 0) fail(`${label}: no trip updates`)
  // A few yard/non-revenue ids are normal; many means the static data is out of date.
  if (stopIds.length && unknownStops.length / stopIds.length > 0.1) {
    fail(
      `${label}: ${unknownStops.length} of ${stopIds.length} stop ids unknown, e.g. ${[...new Set(unknownStops)].slice(0, 5).join(',')}`
    )
  }
  return trips
}

// Subway.
const subway: FeedMessage[] = []
for (const name of Object.keys(FEEDS)) {
  const feed = feedOrFail(name, name)
  if (!feed) continue
  subway.push(feed)
  const routes = new Set(feed.entity.flatMap(e => (e.tripUpdate ? [e.tripUpdate.trip?.routeId ?? ''] : [])))
  checkTripFeed(name, feed, id => !!index.stopName(id), `, routes ${[...routes].sort().join(',')}`)
  const unknownRoutes = [...routes].filter(r => !FEEDS[name]!.includes(r))
  if (unknownRoutes.length) fail(`${name}: routes missing from FEEDS: ${unknownRoutes.join(',')}`)
}
for (const stopId of ['127', '631', 'R20', 'A41', 'L08']) {
  const stop = index.resolve(index.data.stops[stopId]?.station ?? stopId)
  if (!stop) {
    fail(`static data has no stop ${stopId}`)
    continue
  }
  const r = computeArrivals(stop, subway, index, { now: nowS, limit: 3 })
  const n = r.groups.reduce((a, g) => a + g.arrivals.length, 0)
  console.log(`${stop.name}: ${r.groups.length} route/direction groups, ${n} arrivals`)
  if (n === 0) fail(`${stop.name} (${stop.id}): no arrivals`)
}

// PATH.
try {
  const path = await fetchPathFeed({ timeoutMs: 20_000 })
  const trains = Object.values(path.stations).flat()
  const newest = Math.max(0, ...trains.map(t => t.updatedAt))
  const unknownStations = Object.keys(path.stations).filter(id => !pathStation(id))
  const missingStations = PATH_STATIONS.filter(s => !path.stations[s.id]).map(s => s.id)
  const unknownColors = [...new Set(trains.map(t => t.colors))].filter(c => !routeForColors(c))
  console.log(
    `path: ${Object.keys(path.stations).length} stations, ${trains.length} trains, age ${nowS - newest}s, ${path.skipped} skipped entries`
  )
  if (path.skipped) fail(`path: ${path.skipped} entries the parser could not read`)
  if (Math.abs(nowS - newest) > 600) fail(`path: newest update ${newest} is ${nowS - newest}s old`)
  if (unknownStations.length) fail(`path: stations missing from PATH_STATIONS: ${unknownStations.join(',')}`)
  if (missingStations.length) fail(`path: stations missing from the feed: ${missingStations.join(',')}`)
  if (unknownColors.length) fail(`path: line colors with no route: ${unknownColors.join(' ')}`)
  const jsq = computePathArrivals(pathStation('JSQ')!, path, { now: nowS, limit: 3 })
  const n = jsq.groups.reduce((a, g) => a + g.arrivals.length, 0)
  console.log(`${jsq.station.name}: ${jsq.groups.length} route/direction groups, ${n} arrivals`)
  if (n === 0) fail('Journal Square (JSQ): no arrivals')
} catch (err) {
  fail(`path: ${(err as Error).message}`)
}

// LIRR, Metro-North, NYC Ferry. Each with a stop that has service at the hours this runs:
// Jamaica, Grand Central, Wall St/Pier 11.
const MAIN_STOP: Record<string, string> = { lirr: '102', mnr: '1', ferry: '87' }
for (const agency of agencies) {
  const { data, id } = agency
  const feed = feedOrFail(id, agency.tripsFeed)
  const positions = agency.vehiclesFeed ? feedOrFail(id, agency.vehiclesFeed) : feed
  if (!feed || !positions) continue
  const trips = checkTripFeed(id, feed, s => !!data.stops[s])
  const routeIds = new Set(trips.map(t => t.trip?.routeId || data.trips?.[t.trip?.tripId ?? '']?.route || ''))
  const unknownRoutes = [...routeIds].filter(r => r && !data.routes[r])
  if (unknownRoutes.length) fail(`${id}: routes missing from the static data: ${unknownRoutes.join(',')}`)
  // The static schedule is a day behind at worst; many unknown trips means the refresh is failing.
  const unscheduled = data.trips ? trips.filter(t => !data.trips![t.trip?.tripId ?? '']) : []
  if (trips.length && unscheduled.length / trips.length > 0.2)
    fail(`${id}: ${unscheduled.length} of ${trips.length} trips are not in the static schedule`)
  const { vehicles } = computeAgencyVehicles(positions === feed ? [feed] : [positions, feed], data, { now: nowS })
  if (vehicles.length === 0) fail(`${id}: no vehicle positions`)
  const main = data.stops[MAIN_STOP[id] ?? '']
  if (!main) {
    fail(`${id}: static data has no stop ${MAIN_STOP[id]}`)
    continue
  }
  const n = computeAgencyArrivals(main, feed, data, { now: nowS, limit: 30 }).arrivals.length
  console.log(
    `${id}: ${vehicles.length} vehicles, ${unscheduled.length} trips not in the static schedule; ${main.name}: ${n} departures`
  )
  if (n === 0) fail(`${id}: no departures at ${main.name}`)
}

// Citi Bike.
try {
  const [information, status] = await Promise.all([
    fetchGbfs('station_information', { timeoutMs: 20_000 }),
    fetchGbfs('station_status', { timeoutMs: 20_000 }),
  ])
  const joined = joinStations(information, status)
  // Seasonal closures take stations off the street (is_installed 0); the join should keep the rest.
  const installed = status.data.stations.filter(s => s.is_installed === 1 || s.is_installed === true).length
  const stations = [...joined.byId.values()]
  let bikes = 0,
    ebikes = 0,
    docks = 0
  for (const s of stations) {
    bikes += s.bikes
    ebikes += s.ebikes
    docks += s.docks
  }
  console.log(
    `citibike: ${stations.length} of ${installed} installed stations joined, ${bikes} bikes, ${ebikes} e-bikes, ${docks} free docks, ` +
      `age ${nowS - joined.updatedAt}s`
  )
  if (Math.abs(nowS - joined.updatedAt) > 600) fail(`citibike: station_status is ${nowS - joined.updatedAt}s old`)
  if (stations.length < 1000 || stations.length < installed * 0.95)
    fail(`citibike: only ${stations.length} of ${installed} installed stations joined`)
  if (bikes + ebikes === 0 || docks === 0) fail('citibike: no bikes or no free docks anywhere')
  if (!stations.some(s => s.ebikes > 0)) fail('citibike: no e-bikes anywhere (num_ebikes_available gone?)')
  const near = nearestStations(stations, TIMES_SQ.lat, TIMES_SQ.lon, 3)
  console.log(`citibike near Times Sq: ${near.map(s => `${s.name} (${s.distance} m)`).join(', ')}`)
  if (!near[0] || near[0].distance > 500) fail('citibike: no station within 500 m of Times Sq')
} catch (err) {
  fail(`citibike: ${(err as Error).message}`)
}

// Buses: Bus Time needs a key, which the scheduled run may not have.
const busKey = process.env.BUSTIME_KEY?.trim()
if (!busKey) console.log('bus: skipped, BUSTIME_KEY is not set')
else {
  try {
    const [stop, unknown] = await Promise.all(
      [BUS_STOP, '999999'].map(s => fetchStopMonitoring(s, busKey, { timeoutMs: 20_000 }))
    )
    const unknownRoutes = [...new Set(stop!.visits.map(v => v.routeId))].filter(r => !BUS_DATA.routes[r])
    const timed = stop!.visits.filter(v => v.time !== undefined).length
    const name = stop!.visits[0]?.stopName ?? BUS_STOP
    console.log(
      `bus ${name}: ${stop!.visits.length} buses, ${timed} with a time, age ${nowS - (stop!.updatedAt ?? 0)}s`
    )
    if (stop!.error) fail(`bus stop ${BUS_STOP}: ${stop!.error}`)
    if (Math.abs(nowS - (stop!.updatedAt ?? 0)) > 600)
      fail(`bus stop ${BUS_STOP}: response timestamp ${stop!.updatedAt}`)
    if (stop!.visits.length === 0) fail(`bus stop ${BUS_STOP}: no buses on their way`)
    if (unknownRoutes.length) fail(`bus: routes missing from the static data: ${unknownRoutes.join(',')}`)
    // src/routes/bus.ts answers 404 when the parser reads the error as not found.
    if (!unknown!.notFound) fail(`bus: unknown stop answered ${JSON.stringify(unknown!.error)}`)

    // Vehicles: the M15 runs around the clock. Bus Time takes the plain route id as its line ref.
    const [m15, noRoute] = await Promise.all(
      ['M15', 'ZZZ'].map(r => fetchVehicleMonitoring(r, busKey, { timeoutMs: 20_000 }))
    )
    console.log(`bus M15: ${m15!.vehicles.length} buses, age ${nowS - (m15!.updatedAt ?? 0)}s`)
    if (m15!.error) fail(`bus vehicles M15: ${m15!.error}`)
    if (m15!.vehicles.length === 0) fail('bus vehicles M15: no buses')
    if (m15!.vehicles.some(v => !v.stopId || v.recordedAt === undefined))
      fail('bus vehicles M15: buses without a next stop or a time')
    // src/routes/bus.ts answers 404 when the parser reads the error as not found.
    if (!noRoute!.notFound) fail(`bus: unknown route answered ${JSON.stringify(noRoute!.error)}`)

    // Nearby stops, from the Discovery API.
    const { lat, lon } = BUS_STOP_POINT
    const stops = await fetchStopsForLocation(lat, lon, NEARBY_RADIUS_M, busKey, { timeoutMs: 20_000 })
    console.log(`bus stops near ${BUS_STOP}: ${stops.length}`)
    if (!stops.some(s => s.code === BUS_STOP)) fail(`bus stops: ${BUS_STOP} not near its own position`)
    const unknownStopRoutes = [...new Set(stops.flatMap(s => s.routeIds))].filter(r => !BUS_DATA.routes[r])
    if (unknownStopRoutes.length) fail(`bus stops: routes missing from the static data: ${unknownStopRoutes.join(',')}`)
  } catch (err) {
    fail(`bus: ${(err as Error).message}`)
  }
}

// Alerts.
for (const name of alertFeeds) {
  const label = name.split('/').slice(-2).join('/')
  const feed = feedOrFail(label, name)
  if (!feed) continue
  const { alerts, updatedAt } = computeAlerts(feed, { now: nowS })
  console.log(`${label}: ${feed.entity.length} alerts, ${alerts.length} in effect, age ${nowS - (updatedAt ?? 0)}s`)
  if (Math.abs(nowS - (updatedAt ?? 0)) > 86_400)
    fail(`${label}: header timestamp ${updatedAt} is ${nowS - (updatedAt ?? 0)}s old`)
  if (feed.entity.some(e => !e.alert)) fail(`${label}: entities that are not alerts`)
  // Every MTA alert carries its status in the extension; NYC Ferry's (a full URL) don't.
  if (name.startsWith('https://')) continue
  const types = feed.entity.flatMap(e => (e.alert ? [alertType(e.alert)] : []))
  const untyped = types.filter(t => !t).length
  if (untyped) fail(`${label}: ${untyped} alerts without an alert_type`)
  const unknown = [...new Set(types.filter(t => t && !statusRank(t)))]
  if (unknown.length) fail(`${label}: statuses missing from ALERT_STATUSES: ${unknown.join(', ')}`)
}

const base = process.env.TRANSIT_BASE_URL?.replace(/\/$/, '')
if (base) {
  const token = process.env.TRANSIT_TOKEN?.split(',')[0]?.trim() ?? ''
  const call = async (path: string, withToken: boolean) => {
    const res = await fetch(base + path, { headers: withToken ? { 'x-transit-token': token } : {} })
    console.log(
      `GET ${path} ${withToken ? 'with' : 'without'} token: ${res.status}, x-vercel-cache ${res.headers.get('x-vercel-cache')}`
    )
    return res
  }
  const expectStatus = (res: Response, status: number, what: string) => {
    if (res.status !== status) fail(`${what}: expected ${status}, got ${res.status}`)
  }
  /** A preview route answers one line starting with the stop's name. */
  const expectPreview = async (path: string, stopName: string) => {
    const res = await call(`${path}&smoke=${nowS}`, true)
    expectStatus(res, 200, `${path} with token`)
    const line = await res.text()
    console.log(`preview: ${line.trimEnd()}`)
    if (!line.startsWith(`${stopName} · `) || !line.endsWith('\n') || line.trimEnd().includes('\n'))
      fail(`${path}: unexpected line ${JSON.stringify(line)}`)
  }

  expectStatus(await call('/health', false), 200, '/health')
  const arrivals = `/subway/arrivals?stop=${encodeURIComponent(index.data.stops['127']!.station)}&smoke=${nowS}`
  expectStatus(await call(arrivals, false), 401, 'arrivals without token')
  expectStatus(await call(arrivals, true), 200, 'arrivals with token')
  const again = await call(arrivals, true)
  expectStatus(again, 200, 'arrivals again')
  if (!['HIT', 'STALE'].includes(again.headers.get('x-vercel-cache') ?? ''))
    fail('repeated arrivals call was not a CDN hit')
  expectStatus(await call(arrivals, false), 401, 'arrivals without token after a cached hit')
  expectStatus(await call('/stops/search?q=times%20sq', false), 401, 'search without token')
  expectStatus(await call('/stops/search?q=times%20sq', true), 200, 'search with token')
  expectStatus(await call(`/preview/subway?q=times%20sq&smoke=${nowS}`, false), 401, 'preview without token')
  await expectPreview('/preview/subway?q=times%20sq', 'Times Sq-42 St')

  const pathArrivals = `/path/arrivals?station=JSQ&smoke=${nowS}`
  expectStatus(await call(pathArrivals, false), 401, 'PATH arrivals without token')
  expectStatus(await call(pathArrivals, true), 200, 'PATH arrivals with token')
  expectStatus(await call('/path/stations', true), 200, 'PATH stations with token')
  await expectPreview('/preview/path?q=journal%20square', 'Journal Square')

  // These all go through one function behind a rewrite with a query string (see vercel.json).
  const lirr = `/lirr/arrivals?station=${MAIN_STOP.lirr}&smoke=${nowS}`
  expectStatus(await call(lirr, false), 401, 'LIRR arrivals without token')
  const lirrRes = await call(lirr, true)
  expectStatus(lirrRes, 200, 'LIRR arrivals with token')
  if (lirrRes.status === 200 && (await lirrRes.json()).station?.id !== MAIN_STOP.lirr)
    fail("LIRR arrivals: not the requested station's")
  const others = [
    '/mnr/stations?q=grand%20central',
    '/ferry/stops',
    '/ferry/vehicles',
    '/mnr/alerts',
    '/bus/alerts',
    '/subway/alerts?route=A',
    '/subway/vehicles?route=L',
  ]
  for (const [i, res] of (await Promise.all(others.map(path => call(path, true)))).entries())
    expectStatus(res, 200, others[i]!)
  expectStatus(await call('/lirr/nope', true), 404, 'an unknown agency route')
  if (busKey) {
    const bus = `/bus/arrivals?stop=${BUS_STOP}&smoke=${nowS}`
    expectStatus(await call(bus, false), 401, 'bus arrivals without token')
    expectStatus(await call(bus, true), 200, 'bus arrivals with token (is BUSTIME_KEY set on the deployment?)')
    expectStatus(await call(`/bus/vehicles?route=M15&smoke=${nowS}`, true), 200, 'bus vehicles with token')
    const near = `/bus/nearby?lat=${BUS_STOP_POINT.lat}&lon=${BUS_STOP_POINT.lon}&smoke=${nowS}`
    expectStatus(await call(near, true), 200, 'bus nearby with token')
  }

  const nearby = `/citibike/nearby?lat=${TIMES_SQ.lat}&lon=${TIMES_SQ.lon}&n=3&smoke=${nowS}`
  expectStatus(await call(nearby, false), 401, 'Citi Bike nearby without token')
  const nearRes = await call(nearby, true)
  expectStatus(nearRes, 200, 'Citi Bike nearby with token')
  const first = nearRes.ok
    ? ((await nearRes.json()) as { stations?: { id: string; name: string }[] }).stations?.[0]
    : undefined
  if (!first) fail('Citi Bike nearby: no stations')
  else {
    console.log(`citibike nearby: ${first.name}`)
    expectStatus(
      await call(`/citibike/station?id=${encodeURIComponent(first.id)}&smoke=${nowS}`, true),
      200,
      'Citi Bike station with token'
    )
  }

  await expectPreview(`/preview/mnr?station=${MAIN_STOP.mnr}`, AGENCIES.mnr!.data.stops[MAIN_STOP.mnr!]!.name)
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s)`)
  process.exit(1)
}
console.log('\nsmoke test passed')
