/**
 * The MTA's GTFS-realtime alert extension (`gtfs-realtime-service-status.proto`, "Mercury").
 * `gtfs-realtime-bindings` doesn't decode it but keeps its bytes (protobufjs `$unknowns`, which
 * encoding writes back). Only `MercuryAlert.alert_type` is read, straight from the wire format,
 * so no `.proto` file is needed.
 */

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

const utf8 = new TextDecoder()

/** Calls `onField` for each field of one message; LEN fields get their bytes, others nothing. */
function eachField(bytes: Uint8Array, onField: (field: number, value: Uint8Array | undefined) => void): void {
  let pos = 0
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      if (pos >= bytes.length) throw new Error('truncated varint')
      const b = bytes[pos++]!
      // Past 2^53 the value is wrong, but only tags and lengths are used, which never get there.
      result += (b & 0x7f) * 2 ** shift
      if (b < 0x80) return result
      shift += 7
    }
  }
  while (pos < bytes.length) {
    const tag = varint()
    const wireType = tag % 8
    const field = Math.floor(tag / 8)
    if (wireType === 0) varint()
    else if (wireType === 1) pos += 8
    else if (wireType === 5) pos += 4
    else if (wireType === 2) {
      const len = varint()
      if (pos + len > bytes.length) throw new Error('truncated field')
      onField(field, bytes.subarray(pos, pos + len))
      pos += len
      continue
    } else throw new Error(`unsupported wire type ${wireType}`)
    if (pos > bytes.length) throw new Error('truncated field')
    onField(field, undefined)
  }
}

/**
 * `MercuryAlert.alert_type` of a decoded alert, undefined when it has none (NYC Ferry) or the
 * bytes can't be read: the category is extra, the alert still shows.
 */
export function alertType(alert: object): string | undefined {
  const unknowns = (alert as { $unknowns?: Uint8Array[] }).$unknowns ?? []
  let type: string | undefined
  try {
    // Each entry is one whole field, tag included.
    for (const bytes of unknowns) {
      eachField(bytes, (field, mercury) => {
        if (field !== MERCURY_ALERT || !mercury) return
        eachField(mercury, (f, v) => {
          if (f === ALERT_TYPE && v) type = utf8.decode(v)
        })
      })
    }
  } catch {
    return undefined
  }
  return type || undefined
}
