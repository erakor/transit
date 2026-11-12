/**
 * Records the live feeds into test/fixtures.
 *
 *   pnpm record-fixtures            # everything
 *   pnpm record-fixtures transit    # GTFS-realtime and PATH feeds
 *   pnpm record-fixtures citibike   # the Citi Bike feeds
 *   pnpm record-fixtures bus        # the Bus Time fixtures (needs BUSTIME_KEY; skipped without it)
 *
 * Transit: every GTFS-realtime feed as <name>.pb (named by
 * `fixtureName`, which the tests' fetcher uses too) and the PATH feed as ridepath.json. Alert
 * feeds are cut down to the alerts in effect when recorded (the full subway one is half a
 * megabyte of future planned work). Re-run `pnpm build:static` first if stops changed.
 *
 * Citi Bike: test/fixtures/citibike-<feed>.json, the live feeds trimmed to the stations around
 * Times Sq (the full ones are about 1 MB each), untouched, in feed order.
 *
 * Bus: Bus Time's answers for the fixture stop (`BUS_STOP`) and for a stop it doesn't know, as
 * test/fixtures/bustime-<stop>.json. The key is in the request only, never in what is written.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { AGENCIES } from '#src/agency/agencies.js'
import { inEffect } from '#src/alerts.js'
import { gbfsUrl } from '#src/citibike/feeds.js'
import { distanceMeters } from '#src/citibike/stations.js'
import { decodeFeed, feedUrl } from '#src/gtfsrt.js'
import { parsePathFeed, PATH_FEED_URL } from '#src/path/feed.js'
import { BUS_ALERTS_FEED } from '#src/routes/bus.js'
import { SUBWAY_ALERTS_FEED } from '#src/routes/alerts.js'
import { FEEDS } from '#src/subway/feeds.js'
import { stopMonitoringUrl } from '#src/bus/siri.js'
import { BUS_STOP, fixtureName, TIMES_SQ } from '../test/helpers.js'

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime
const out = (file: string) => fileURLToPath(new URL(`../test/fixtures/${file}`, import.meta.url))
const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res
}

async function recordTransit(): Promise<void> {
  const agencies = Object.values(AGENCIES)
  const feeds = [
    ...Object.keys(FEEDS),
    ...agencies.flatMap(a => [a.tripsFeed, ...(a.vehiclesFeed ? [a.vehiclesFeed] : [])]),
  ]
  const alertFeeds = new Set([SUBWAY_ALERTS_FEED, BUS_ALERTS_FEED, ...agencies.map(a => a.alertsFeed)])

  // All at once, so the recordings share one clock.
  const recorded = await Promise.all(
    [...feeds, ...alertFeeds].map(async feed => {
      const url = feedUrl(feed)
      return {
        feed,
        name: fixtureName(url),
        bytes: new Uint8Array(await (await get(url)).arrayBuffer()) as Uint8Array,
      }
    })
  )

  let newest = 0
  for (const r of recorded) {
    const msg = decodeFeed(r.bytes)
    const stamp = Number(msg.header.timestamp ?? 0)
    if (alertFeeds.has(r.feed)) {
      const all = msg.entity.length
      // An alert without periods is always in effect; one with periods keeps those covering now.
      msg.entity = msg.entity.filter(e => {
        const periods = e.alert?.activePeriod ?? []
        if (e.alert && periods.length) e.alert.activePeriod = periods.filter(p => inEffect(p, stamp))
        return periods.length === 0 || e.alert!.activePeriod!.length > 0
      })
      r.bytes = FeedMessage.encode(msg).finish()
      console.log(`${r.name}: kept ${msg.entity.length} of ${all} alerts`)
    } else {
      newest = Math.max(newest, stamp)
    }
    await writeFile(out(`${r.name}.pb`), r.bytes)
    console.log(`${r.name}: ${r.bytes.length} bytes, ${msg.entity.length} entities, header ${stamp}`)
  }
  console.log(`Update FIXTURE_NOW_MS in test/helpers.ts to the newest header timestamp: ${newest}_000.`)

  const body = await (await get(PATH_FEED_URL)).text()
  const trains = Object.values(parsePathFeed(JSON.parse(body)).stations).flat()
  await writeFile(out('ridepath.json'), body)
  console.log(`ridepath.json: ${body.length} bytes, ${trains.length} trains`)
  console.log(
    `Update PATH_FIXTURE_NOW_MS in test/helpers.ts to the newest update: ${Math.max(...trains.map(t => t.updatedAt))}_000.`
  )
}

async function recordCitibike(): Promise<void> {
  const RADIUS_M = 800
  type Feed = { data: { stations: { station_id: string; lat?: number; lon?: number }[] } }
  // The raw bodies, fetched together so the two snapshots are as close in time as possible.
  const [information, status] = await Promise.all(
    (['station_information', 'station_status'] as const).map(
      async name => (await (await get(gbfsUrl(name))).json()) as Feed
    )
  )
  const feeds = { station_information: information!, station_status: status! }
  const keep = new Set(
    information!.data.stations
      .filter(s => distanceMeters(TIMES_SQ.lat, TIMES_SQ.lon, s.lat ?? NaN, s.lon ?? NaN) <= RADIUS_M)
      .map(s => s.station_id)
  )
  for (const [name, feed] of Object.entries(feeds)) {
    const total = feed.data.stations.length
    const kept = {
      ...feed,
      data: { ...feed.data, stations: feed.data.stations.filter(s => keep.has(s.station_id)) },
    }
    await writeFile(out(`citibike-${name}.json`), JSON.stringify(kept, null, 1) + '\n')
    console.log(`citibike ${name}: kept ${kept.data.stations.length} of ${total} stations`)
  }
}

async function recordBus(): Promise<void> {
  const key = process.env.BUSTIME_KEY?.trim()
  if (!key) {
    if (only === 'bus') throw new Error('BUSTIME_KEY is not set')
    console.log('bus: skipped, BUSTIME_KEY is not set')
    return
  }
  for (const stop of [BUS_STOP, '999999']) {
    const url = stopMonitoringUrl(stop, key)
    // `get` would put the URL, and so the key, in its error.
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`bustime stop ${stop}: HTTP ${res.status}`)
    const body = JSON.stringify(await res.json(), null, 1) + '\n'
    await writeFile(out(fixtureName(url)), body)
    console.log(`${fixtureName(url)}: ${body.length} bytes`)
    if (stop === BUS_STOP) {
      const stamp = (JSON.parse(body) as { Siri?: { ServiceDelivery?: { ResponseTimestamp?: string } } }).Siri
        ?.ServiceDelivery?.ResponseTimestamp
      console.log(`Update BUS_FIXTURE_NOW_MS in test/helpers.ts to ${Math.floor(Date.parse(stamp ?? '') / 1000)}_000.`)
    }
  }
}

const recorders: Record<string, () => Promise<void>> = {
  transit: recordTransit,
  citibike: recordCitibike,
  bus: recordBus,
}
const only = process.argv[2]
if (only && !recorders[only]) throw new Error(`unknown provider ${only}: ${Object.keys(recorders).join(', ')}`)
for (const [name, record] of Object.entries(recorders)) if (!only || only === name) await record()
