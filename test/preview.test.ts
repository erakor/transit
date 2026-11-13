import { describe, expect, it } from 'vitest'
import type { ArrivalsResult, RouteDirectionArrivals } from '#src/subway/schemas.js'
import { PREVIEW_MAX_ROUTES, previewLine } from '#src/subway/preview.js'

const NOW = 1_000_000

function group(name: string, direction: 'N' | 'S', secondsAway: number[], route = name): RouteDirectionArrivals {
  return {
    route,
    name,
    direction,
    color: '#000000',
    textColor: '#FFFFFF',
    headsign: '',
    arrivals: secondsAway.map((s, i) => ({
      time: NOW + s,
      headsign: '',
      tripId: `${route}${direction}${i}`,
      assigned: true,
      change: null,
      stalled: false,
      delayed: false,
    })),
  }
}

function result(groups: RouteDirectionArrivals[]): ArrivalsResult {
  return { stop: { id: 'X', name: 'Bedford Av', stops: ['X'] }, updatedAt: NOW, groups }
}

describe('previewLine', () => {
  it("lists each route's next train per direction, rounded down", () => {
    expect(previewLine(result([group('L', 'N', [150, 500]), group('L', 'S', [299])]), NOW)).toBe(
      'Bedford Av · L ↑2 ↓4 min'
    )
  })

  it('shows a train already due as 0 and a single direction alone', () => {
    expect(previewLine(result([group('G', 'S', [-10])]), NOW)).toBe('Bedford Av · G ↓0 min')
  })

  it('keeps the sooner of a route and its diamond express', () => {
    const line = previewLine(result([group('6', 'S', [600]), group('6', 'S', [120], '6X')]), NOW)
    expect(line).toBe('Bedford Av · 6 ↓2 min')
  })

  it('says so when no train is coming', () => {
    expect(previewLine(result([]), NOW)).toBe('Bedford Av · no trains soon')
    expect(previewLine(result([group('L', 'N', [])]), NOW)).toBe('Bedford Av · no trains soon')
  })

  it(`lists at most ${PREVIEW_MAX_ROUTES} routes`, () => {
    const many = ['1', '2', '3', '7', 'N', 'Q', 'R', 'W'].map(r => group(r, 'N', [60]))
    const line = previewLine(result(many), NOW)
    expect(line).toBe('Bedford Av · 1 ↑1 · 2 ↑1 · 3 ↑1 · 7 ↑1 · N ↑1 · Q ↑1 min · …')
  })
})
