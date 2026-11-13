import { fallbackRoute, num, type FeedMessage } from './gtfsrt.js'
import { alertType, splitAlertId, statusName, statusRank } from './mercury.js'
import type { Alert, AlertStop, AlertsResult, RouteDisplay } from './schema.js'

type Entity = {
  routeId?: string | null
  stopId?: string | null
  directionId?: number | null
  trip?: { routeId?: string | null } | null
}

export interface AlertsOptions {
  now: number
  /**
   * Keeps an alert when any of its informed entities passes; all alerts without it.
   * `directionId` is the entity's own, when it has one.
   */
  match?: (routeId: string, stopId: string, directionId: number | undefined) => boolean
  /** Display data for a route id; without it, or for unknown ids, `fallbackRoute`. */
  route?: (id: string) => RouteDisplay | undefined
  /** A stop an informed entity names, as the response shows it; undefined leaves it out. */
  stop?: (stopId: string, directionId: number | undefined) => AlertStop | undefined
}

type Period = { start?: Parameters<typeof num>[0]; end?: Parameters<typeof num>[0] }

/** Whether an alert's active period covers `now` (epoch seconds). A missing bound is open. */
export function inEffect(period: Period, now: number): boolean {
  return (num(period.start) ?? 0) <= now && (num(period.end) ?? Infinity) >= now
}

function plain(
  text: { translation?: { text?: string | null; language?: string | null }[] | null } | null | undefined
): string {
  const all = text?.translation ?? []
  const pick = all.find(t => t.language === 'en') ?? all.find(t => !t.language?.endsWith('html')) ?? all[0]
  return (pick?.text ?? '').trim()
}

/**
 * The alerts in effect at `now`, from an already decoded alerts feed. The MTA publishes planned
 * work weeks ahead with one active period per affected night, so most of a feed is not in effect
 * at any given time. An alert whose parts have different statuses comes as one entity per status
 * (`lmm:alert:276100:26` and `:25`); the parts that pass `match` are merged into one alert with
 * the most serious status. Current events come first, then planned work; by priority, then
 * newest first. Pure.
 */
export function computeAlerts(feed: FeedMessage, { now, match, route, stop }: AlertsOptions): AlertsResult {
  const byId = new Map<string, Alert[]>()
  const routeOf = (e: Entity) => e.routeId || e.trip?.routeId || ''
  const directionOf = (e: Entity) => (Object.hasOwn(e, 'directionId') ? (e.directionId ?? undefined) : undefined)
  for (const entity of feed.entity) {
    const a = entity.alert
    if (!a || entity.isDeleted) continue
    // The cheap filter first: planned work can carry hundreds of periods.
    const informed: Entity[] = a.informedEntity ?? []
    if (match && !informed.some(e => match(routeOf(e), e.stopId ?? '', directionOf(e)))) continue
    const periods = a.activePeriod ?? []
    const period = periods.find(p => inEffect(p, now))
    if (periods.length > 0 && !period) continue
    const header = plain(a.headerText)
    if (!header) continue

    const { id, rank } = splitAlertId(entity.id)
    const category = alertType(a) ?? (rank ? statusName(rank) : undefined) ?? null
    const routeIds = [...new Set(informed.map(routeOf).filter(Boolean))]
    const stops: AlertStop[] = []
    for (const e of informed) {
      const s = e.stopId ? stop?.(e.stopId, directionOf(e)) : undefined
      if (s) stops.push(s)
    }
    const parts = byId.get(id) ?? []
    byId.set(id, parts)
    parts.push({
      id,
      planned: entity.id.includes('planned_work'),
      category,
      priority: rank ?? (category ? statusRank(category) : undefined) ?? null,
      header,
      description: plain(a.descriptionText),
      routes: routeIds.map(id => route?.(id) ?? fallbackRoute(id)),
      stops,
      start: num(period?.start) ?? null,
      end: num(period?.end) ?? null,
    })
  }

  const alerts = [...byId.values()].map(merge)
  alerts.sort(
    (a, b) =>
      Number(a.planned) - Number(b.planned) ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (b.start ?? 0) - (a.start ?? 0) ||
      a.id.localeCompare(b.id)
  )
  return { updatedAt: num(feed.header?.timestamp) ?? null, alerts }
}

/** One alert from its parts: the most serious one's status, every part's routes and stops. */
function merge(parts: Alert[]): Alert {
  const [first] = [...parts].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const routes = new Map<string, RouteDisplay>()
  for (const p of parts) for (const r of p.routes) if (!routes.has(r.id)) routes.set(r.id, r)
  const starts = parts.map(p => p.start)
  const ends = parts.map(p => p.end)
  return {
    ...first!,
    routes: [...routes.values()],
    stops: mergeStops(parts.flatMap(p => p.stops)),
    start: starts.includes(null) ? null : Math.min(...(starts as number[])),
    end: ends.includes(null) ? null : Math.max(...(ends as number[])),
  }
}

/** Each stop once; one named for both directions affects both. */
function mergeStops(stops: AlertStop[]): AlertStop[] {
  const byId = new Map<string, AlertStop>()
  for (const s of stops) {
    const seen = byId.get(s.id)
    if (!seen) byId.set(s.id, s)
    else if (seen.direction !== s.direction) byId.set(s.id, { ...seen, direction: null })
  }
  return [...byId.values()]
}
