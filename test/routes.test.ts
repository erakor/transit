import { describe, expect, it, vi } from 'vitest'
import { GET as healthGET } from '../api/health.js'
import { arrivalsHandler } from '#src/routes/arrivals.js'
import { searchHandler } from '#src/routes/search.js'
import { subwayPreviewHandler } from '#src/routes/preview.js'
import { agencyHandler } from '#src/routes/agency.js'
import { subwayAlertsHandler } from '#src/routes/alerts.js'
import { subwayVehiclesHandler } from '#src/routes/vehicles.js'
import { pathArrivalsHandler, pathPreviewHandler, pathStationsHandler } from '#src/routes/path.js'
import { LIVE_CACHE, PREVIEW_CACHE, STATIC_CACHE } from '#src/http.js'
import { SUBWAY_DATA } from '#src/data/subway.generated.js'
import { ErrorBody } from '#src/schema.js'
import { ArrivalsResponse } from '#src/subway/schemas.js'
import {
  auth,
  BUS_FIXTURE_NOW_MS,
  BUS_STOP,
  fixtureFetcher,
  FIXTURE_NOW_MS,
  get,
  PATH_FIXTURE_NOW_MS,
  useRouteTestSetup,
} from './helpers.js'

const TIMES_SQ = SUBWAY_DATA.stops['127']!.station

useRouteTestSetup()

function arrivals(fetcher = fixtureFetcher(), nowMs = FIXTURE_NOW_MS) {
  return { fetcher, GET: arrivalsHandler({ fetcher, now: () => nowMs }) }
}

describe('/health', () => {
  it('needs no token and is never cached', async () => {
    const res = await healthGET(get('/health'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ ok: true, staticFeedVersion: SUBWAY_DATA.feedVersion })
  })
})

describe.each([
  ['/subway/arrivals', `?stop=${encodeURIComponent(TIMES_SQ)}`, () => arrivals().GET],
  ['/stops/search', '?q=times', () => searchHandler()],
  [
    '/preview/subway',
    '?q=bedford',
    () => subwayPreviewHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  ],
  [
    '/path/arrivals',
    '?station=WTC',
    () => pathArrivalsHandler({ fetcher: fixtureFetcher(), now: () => PATH_FIXTURE_NOW_MS }),
  ],
  ['/path/stations', '', () => pathStationsHandler()],
  [
    '/preview/path',
    '?q=hoboken',
    () => pathPreviewHandler({ fetcher: fixtureFetcher(), now: () => PATH_FIXTURE_NOW_MS }),
  ],
  ['/subway/alerts', '?route=A', () => subwayAlertsHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS })],
  [
    '/subway/vehicles',
    '?route=L',
    () => subwayVehiclesHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS }),
  ],
  ['/lirr/arrivals', '?station=102', () => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS })],
  ['/mnr/stations', '?q=rye', () => agencyHandler()],
  ['/ferry/vehicles', '', () => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS })],
  ['/bus/alerts', '', () => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS })],
  [
    '/bus/arrivals',
    `?stop=${BUS_STOP}`,
    () => agencyHandler({ fetcher: fixtureFetcher(), now: () => BUS_FIXTURE_NOW_MS }),
  ],
  ['/preview/mnr', '?station=1', () => agencyHandler({ fetcher: fixtureFetcher(), now: () => FIXTURE_NOW_MS })],
])('%s auth and caching', (path, query, handler) => {
  it('is 401 without a token, uncached and varying on the token header', async () => {
    const res = await handler()(get(path + query))
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('vary')).toBe('x-transit-token')
    expect(await res.json()).toEqual({ error: 'missing token' })
  })

  it('is 401 with a wrong token', async () => {
    const res = await handler()(get(path + query, { 'x-transit-token': 'nope' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid token' })
  })

  it('is 500 when the server has no token configured', async () => {
    vi.stubEnv('TRANSIT_TOKEN', '')
    const res = await handler()(get(path + query, auth))
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('returns a CDN-cacheable answer keyed by the token header', async () => {
    const res = await handler()(get(path + query, auth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(
      path.startsWith('/preview/') ? /^text\/plain/ : /^application\/json/
    )
    expect(res.headers.get('cache-control')).toMatch(
      /^public, (max-age=\d+, )?s-maxage=\d+, stale-while-revalidate=\d+$/
    )
    expect(res.headers.get('vary')).toBe('x-transit-token')
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('/subway/arrivals', () => {
  it('returns pre-joined arrivals for a station complex with live cache headers', async () => {
    const { GET, fetcher } = arrivals()
    const res = await GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}&limit=2`, auth))
    expect(res.headers.get('cache-control')).toBe(LIVE_CACHE)
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=20, stale-while-revalidate=40')
    expect(fetcher.calls.sort()).toEqual(['gtfs', 'gtfs-ace', 'gtfs-nqrw'])
    const body = ArrivalsResponse.parse(await res.json())
    expect(body.stop).toMatchObject({ id: TIMES_SQ, name: 'Times Sq-42 St' })
    expect(body.updatedAt).toBeTypeOf('number')
    expect(body.groups.length).toBeGreaterThan(4)
    for (const g of body.groups) expect(g.arrivals.length).toBeLessThanOrEqual(2)
    expect(body.unavailableFeeds).toBeUndefined()
  })

  it('accepts a plain stop id and only fetches the feeds it needs', async () => {
    const { GET, fetcher } = arrivals()
    const res = await GET(get('/subway/arrivals?stop=L08', auth))
    expect(res.status).toBe(200)
    expect(fetcher.calls).toEqual(['gtfs-l'])
    const body = await res.json()
    expect(body.stop).toMatchObject({ id: 'L08', name: 'Bedford Av' })
    expect(new Set(body.groups.map((g: { route: string }) => g.route))).toEqual(new Set(['L']))
  })

  it('reuses fetched feeds within the in-function window', async () => {
    const { GET, fetcher } = arrivals()
    await GET(get('/subway/arrivals?stop=L08', auth))
    await GET(get('/subway/arrivals?stop=L06', auth))
    expect(fetcher.calls).toEqual(['gtfs-l'])
  })

  it('returns what it has when some feeds fail, with a short cache', async () => {
    const { GET } = arrivals(fixtureFetcher(['gtfs-ace']))
    const res = await GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}`, auth))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=5')
    const body = ArrivalsResponse.parse(await res.json())
    expect(body.unavailableFeeds).toEqual(['gtfs-ace'])
    expect(body.groups.some(g => g.route === 'A')).toBe(false)
    expect(body.groups.some(g => g.route === '1')).toBe(true)
  })

  it('is 502 when every feed fails', async () => {
    const { GET } = arrivals(fixtureFetcher(['gtfs-l']))
    const res = await GET(get('/subway/arrivals?stop=L08', auth))
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    ErrorBody.parse(await res.json())
  })

  it.each([
    ['', 400, 'stop is required'],
    ['?stop=', 400, 'stop is required'],
    ['?stop=%20', 400, 'stop is required'],
    ['?stop=ZZZ', 404, 'unknown stop ZZZ'],
    ['?stop=L08&limit=0', 400, 'limit must be a positive integer'],
    ['?stop=L08&limit=abc', 400, 'limit must be a positive integer'],
    ['?stop=L08&limit=1.5', 400, 'limit must be a positive integer'],
  ])('rejects %s with %i', async (query, status, error) => {
    const res = await arrivals().GET(get(`/subway/arrivals${query}`, auth))
    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(ErrorBody.parse(await res.json())).toEqual({ error })
  })

  it('caps limit at 10', async () => {
    const res = await arrivals().GET(get(`/subway/arrivals?stop=${encodeURIComponent(TIMES_SQ)}&limit=99`, auth))
    const body = ArrivalsResponse.parse(await res.json())
    expect(Math.max(...body.groups.map(g => g.arrivals.length))).toBe(10)
  })
})

describe('/stops/search', () => {
  async function search(q: string, extra = '') {
    const res = await searchHandler()(get(`/stops/search?q=${encodeURIComponent(q)}${extra}`, auth))
    return { res, body: await res.json() }
  }

  it('finds stations case and accent insensitively, with ids usable by /subway/arrivals', async () => {
    for (const q of ['times sq', 'TIMES SQUARE', 'Tímes Sq', '42nd street times']) {
      const { body } = await search(q)
      expect(body.results[0].id, q).toBe(TIMES_SQ)
    }
    const { res, body } = await search('bedford av')
    expect(res.headers.get('cache-control')).toBe(STATIC_CACHE)
    const hit = body.results.find((r: { name: string }) => r.name === 'Bedford Av')
    expect(hit).toMatchObject({ id: 'L08', stops: [{ id: 'L08', name: 'Bedford Av' }] })
    expect(hit.routes).toEqual([{ id: 'L', name: 'L', color: SUBWAY_DATA.routes['L']!.color, textColor: '#FFFFFF' }])
    const arr = await arrivals().GET(get(`/subway/arrivals?stop=${encodeURIComponent(body.results[0].id)}`, auth))
    expect(arr.status).toBe(200)
  })

  it('matches other names in a complex', async () => {
    const { body } = await search('port authority')
    expect(body.results[0].id).toBe(TIMES_SQ)
  })

  it('hides diamond express variants next to their base route', async () => {
    const { body } = await search('grand central')
    const ids = body.results[0].routes.map((r: { id: string }) => r.id)
    expect(ids).toContain('7')
    expect(ids).not.toContain('7X')
  })

  it('respects limit and returns empty results for no match', async () => {
    expect((await search('st', '&limit=3')).body.results).toHaveLength(3)
    expect((await search('zzzz')).body.results).toEqual([])
  })

  it('requires q', async () => {
    const res = await searchHandler()(get('/stops/search?q=%20', auth))
    expect(res.status).toBe(400)
  })
})

describe('/preview/subway', () => {
  function preview(fetcher = fixtureFetcher()) {
    return { fetcher, GET: subwayPreviewHandler({ fetcher, now: () => FIXTURE_NOW_MS }) }
  }

  it('answers one line of text for a station name, cached for the client too', async () => {
    const { GET, fetcher } = preview()
    const res = await GET(get('/preview/subway?q=bedford%20av', auth))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe(PREVIEW_CACHE)
    expect(res.headers.get('cache-control')).toMatch(/max-age=20/)
    expect(fetcher.calls).toEqual(['gtfs-l'])
    const body = await res.text()
    expect(body.endsWith('\n')).toBe(true)
    expect(body.trimEnd()).not.toContain('\n')
    expect(body).toMatch(/^Bedford Av · L (↑\d+ ↓\d+|↑\d+|↓\d+) min\n$/)
  })

  it('takes a station id like /subway/arrivals', async () => {
    const res = await preview().GET(get(`/preview/subway?stop=${encodeURIComponent(TIMES_SQ)}`, auth))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toMatch(/^Times Sq-42 St · /)
    expect(Buffer.byteLength(body)).toBeLessThan(1024)
  })

  it('uses a short cache when some feeds failed', async () => {
    const res = await preview(fixtureFetcher(['gtfs-ace'])).GET(
      get(`/preview/subway?stop=${encodeURIComponent(TIMES_SQ)}`, auth)
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=5, s-maxage=5')
  })

  it.each([
    ['', 400, 'q or stop is required'],
    ['?q=zzzz', 404, 'no matching station'],
    ['?stop=ZZZ', 404, 'unknown stop ZZZ'],
  ])('rejects %s with %i as uncached JSON', async (query, status, error) => {
    const res = await preview().GET(get(`/preview/subway${query}`, auth))
    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error })
  })

  it('is 502 when every feed fails', async () => {
    const res = await preview(fixtureFetcher(['gtfs-l'])).GET(get('/preview/subway?q=bedford%20av', auth))
    expect(res.status).toBe(502)
  })
})
