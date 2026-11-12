import { fallbackRoute, num, type FeedMessage, type RouteDisplay } from './gtfsrt.js'

export interface Alert {
  id: string
  /** Scheduled work rather than something that just happened. */
  planned: boolean
  /** One or two plain-text sentences. Subway texts name routes in brackets: "[A][C] trains". */
  header: string
  /** Longer plain text, "" when there is none. */
  description: string
  routes: RouteDisplay[]
  stops: { id: string; name: string }[]
  /** Start of the period in effect now (epoch seconds), null when open. */
  start: number | null
  end: number | null
}

export interface AlertsResult {
  /** The feed's header timestamp (epoch seconds). */
  updatedAt: number | null
  alerts: Alert[]
}

type Entity = { routeId?: string | null; stopId?: string | null; trip?: { routeId?: string | null } | null }

export interface AlertsOptions {
  now: number
  /** Keeps an alert when any of its informed entities passes; all alerts without it. */
  match?: (routeId: string, stopId: string) => boolean
  /** Display data for a route id; without it, or for unknown ids, `fallbackRoute`. */
  route?: (id: string) => RouteDisplay | undefined
  stopName?: (id: string) => string | undefined
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
 * The alerts in effect at `now`, newest first, from an already decoded alerts feed. The MTA
 * publishes planned work weeks ahead with one active period per affected night, so most of a
 * feed is not in effect at any given time. Pure.
 */
export function computeAlerts(feed: FeedMessage, { now, match, route, stopName }: AlertsOptions): AlertsResult {
  const alerts: Alert[] = []
  const routeOf = (e: Entity) => e.routeId || e.trip?.routeId || ''
  for (const entity of feed.entity) {
    const a = entity.alert
    if (!a || entity.isDeleted) continue
    // The cheap filter first: planned work can carry hundreds of periods.
    const informed: Entity[] = a.informedEntity ?? []
    if (match && !informed.some(e => match(routeOf(e), e.stopId ?? ''))) continue
    const periods = a.activePeriod ?? []
    const period = periods.find(p => inEffect(p, now))
    if (periods.length > 0 && !period) continue
    const header = plain(a.headerText)
    if (!header) continue

    const routeIds = [...new Set(informed.map(routeOf).filter(Boolean))]
    const stops = new Map<string, string>()
    for (const e of informed) {
      const name = e.stopId ? stopName?.(e.stopId) : undefined
      if (name) stops.set(e.stopId!, name)
    }
    alerts.push({
      id: entity.id,
      planned: entity.id.includes('planned_work'),
      header,
      description: plain(a.descriptionText),
      routes: routeIds.map(id => route?.(id) ?? fallbackRoute(id)),
      stops: [...stops].map(([id, name]) => ({ id, name })),
      start: num(period?.start) ?? null,
      end: num(period?.end) ?? null,
    })
  }
  // What just happened first, then planned work; newest first within each.
  alerts.sort(
    (a, b) => Number(a.planned) - Number(b.planned) || (b.start ?? 0) - (a.start ?? 0) || a.id.localeCompare(b.id)
  )
  return { updatedAt: num(feed.header?.timestamp) ?? null, alerts }
}
