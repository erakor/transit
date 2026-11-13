/**
 * The MTA's GTFS-realtime alert extension (`gtfs-realtime-service-status.proto`, "Mercury"), read
 * through `src/protowire.ts`, and the table of alert statuses it names.
 */
import { extension, text } from './protowire.js'

/** Statuses of the MTA's alert system, by rank: 1 is the lowest priority, 35 the highest. */
export const ALERT_STATUSES = [
  'No Scheduled Service',
  'Information Outage',
  'Station Notice',
  'Special Notice',
  'Weekday Schedule',
  'Weekend Schedule',
  'Saturday Schedule',
  'Sunday Schedule',
  'Extra Service',
  'Boarding Change',
  'Special Schedule',
  'Expect Delays',
  'Reduced Service',
  'Planned - Express to Local',
  'Planned - Extra Transfer',
  'Planned - Stops Skipped',
  'Planned - Detour',
  'Planned - Reroute',
  'Planned - Substitute Buses',
  'Planned - Part Suspended',
  'Planned - Suspended',
  'Service Change',
  'Planned Work',
  'Some Delays',
  'Express to Local',
  'Delays',
  'Cancellations',
  'Delays and Cancellations',
  'Stops Skipped',
  'Severe Delays',
  'Detour',
  'Reroute',
  'Substitute Buses',
  'Part Suspended',
  'Suspended',
] as const

/** The rank of a status name (1 to 35), undefined for a name the table doesn't list. */
export function statusRank(status: string): number | undefined {
  const i = (ALERT_STATUSES as readonly string[]).indexOf(status)
  return i < 0 ? undefined : i + 1
}

/** The status name of a rank, undefined outside 1 to 35. */
export function statusName(rank: number): string | undefined {
  return ALERT_STATUSES[rank - 1]
}

/**
 * An alert entity id split into the alert's own id and the status rank the MTA appends to it
 * (`lmm:alert:276100:26`). One alert with parts of different statuses comes as one entity per
 * status, each with that part's routes; they share the id without the rank. Planned work ids
 * (`lmm:planned_work:36463`) carry no rank.
 */
export function splitAlertId(id: string): { id: string; rank?: number } {
  const m = /^(lmm:alert:[^:]+):(\d{1,2})$/.exec(id)
  const rank = m ? Number(m[2]) : 0
  return m && rank >= 1 && rank <= ALERT_STATUSES.length ? { id: m[1]!, rank } : { id }
}

// Alert.mercury_alert = 1001, MercuryAlert.alert_type = 3.
const MERCURY_ALERT = 1001
const ALERT_TYPE = 3

/** `MercuryAlert.alert_type` of a decoded alert, undefined when it has none (NYC Ferry). */
export function alertType(alert: object): string | undefined {
  return text(extension(alert, MERCURY_ALERT), ALERT_TYPE)
}
