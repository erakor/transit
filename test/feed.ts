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

/** Any GTFS-realtime feed from a plain object (protobufjs `fromObject` shape), round-tripped through protobuf encoding. */
export function feedFrom(timestamp: number, entity: Record<string, unknown>[]): FeedMessage {
  const msg = transit_realtime.FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp },
    entity: entity.map((e, i) => ({ id: String(i + 1), ...e })),
  })
  return transit_realtime.FeedMessage.decode(encodeFeed(msg))
}
