import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { FeedMessage } from "../src/subway/feeds.js";

const { transit_realtime } = GtfsRealtimeBindings;

export interface TripSpec {
  id: string;
  route: string;
  stops: [stopId: string, time: number][];
  skipped?: string[];
}

/** Builds a small GTFS-realtime feed, round-tripped through protobuf encoding. */
export function makeFeed(timestamp: number, trips: TripSpec[]): FeedMessage {
  const msg = transit_realtime.FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: "1.0", timestamp },
    entity: trips.map((t, i) => ({
      id: String(i + 1),
      tripUpdate: {
        trip: { tripId: t.id, routeId: t.route },
        stopTimeUpdate: t.stops.map(([stopId, time]) => ({
          stopId,
          arrival: { time },
          departure: { time },
          scheduleRelationship: t.skipped?.includes(stopId) ? 1 : 0,
        })),
      },
    })),
  });
  return transit_realtime.FeedMessage.decode(transit_realtime.FeedMessage.encode(msg).finish());
}

export function encodeFeed(feed: FeedMessage): Uint8Array {
  return transit_realtime.FeedMessage.encode(feed).finish();
}
