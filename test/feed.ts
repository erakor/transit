import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import type { FeedMessage } from '#src/gtfsrt.js'

const { transit_realtime } = GtfsRealtimeBindings

export interface TripSpec {
  id: string
  route: string
  stops: [stopId: string, time: number][]
  skipped?: string[]
}

/** Builds a small feed of trip updates, round-tripped through protobuf encoding. */
export function makeFeed(timestamp: number, trips: TripSpec[]): FeedMessage {
  return feedFrom(
    timestamp,
    trips.map(t => ({
      tripUpdate: {
        trip: { tripId: t.id, routeId: t.route },
        stopTimeUpdate: t.stops.map(([stopId, time]) => ({
          stopId,
          arrival: { time },
          departure: { time },
          scheduleRelationship: t.skipped?.includes(stopId) ? 1 : 0,
        })),
      },
    }))
  )
}

export function encodeFeed(feed: FeedMessage): Uint8Array {
  return transit_realtime.FeedMessage.encode(feed).finish()
}

/**
 * Any GTFS-realtime feed from a plain object (protobufjs `fromObject` shape), round-tripped
 * through protobuf encoding. An entity's `alertType` goes in the MTA's alert extension.
 */
export function feedFrom(timestamp: number, entity: (Record<string, unknown> & { alertType?: string })[]): FeedMessage {
  const msg = transit_realtime.FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp },
    entity: entity.map(({ alertType: _, ...e }, i) => ({ id: String(i + 1), ...e })),
  })
  entity.forEach(({ alertType }, i) => {
    const alert = msg.entity[i]!.alert
    // protobufjs writes `$unknowns` back as they are, as it does for the live feeds' extension.
    if (alert && alertType) withExtension(alert, mercuryAlert(alertType))
  })
  return transit_realtime.FeedMessage.decode(encodeFeed(msg))
}

/**
 * An extension field as protobufjs keeps it in `$unknowns`: field `field`, a message whose
 * fields are strings or varints (bools, enums).
 */
export function extensionField(field: number, values: Record<number, string | number>): Uint8Array {
  const varint = (n: number) => {
    const out: number[] = []
    for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n % 0x80) | 0x80)
    return [...out, n]
  }
  const len = (f: number, bytes: number[]) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes]
  const body = Object.entries(values).flatMap(([f, v]) =>
    typeof v === 'number' ? [...varint(Number(f) * 8), ...varint(v)] : len(Number(f), [...new TextEncoder().encode(v)])
  )
  return new Uint8Array(len(field, body))
}

/** `Alert.mercury_alert` (field 1001) with only `alert_type` (field 3). */
export function mercuryAlert(alertType: string, field = 1001): Uint8Array {
  return extensionField(field, { 3: alertType })
}

/** Gives a decoded message an extension, as protobufjs keeps the ones it doesn't know. */
export function withExtension<T extends object>(message: T, ...fields: Uint8Array[]): T {
  return Object.assign(message, { $unknowns: fields })
}
