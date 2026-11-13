import { num, terminalName, type FeedMessage } from '#src/gtfsrt.js'
import { routeInfo } from './agencies.js'
import { railroadStopTime } from './mtarr.js'
import type { AgencyArrival, AgencyArrivalsResult } from './schemas.js'
import type { AgencyData, AgencyStop } from './types.js'

const SKIPPED = 1
const CANCELED = 3

/**
 * Next departures at `stop`, soonest first, from an already decoded feed. Pure: takes `now`
 * (epoch seconds). One list for all routes and directions, like a station's departure board.
 *
 * A feed that predicts only part of a trip (NYC Ferry: the next stop) is extended with the
 * static schedule when the data has trips: a later stop's time is the last predicted time plus
 * the scheduled running time from there, so the current delay carries down the line.
 */
export function computeAgencyArrivals(
  stop: AgencyStop,
  feed: FeedMessage,
  data: AgencyData,
  { now, limit }: { now: number; limit: number }
): AgencyArrivalsResult {
  const arrivals: AgencyArrival[] = []
  const seen = new Set<string>()
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate
    if (!tu || entity.isDeleted || tu.trip?.scheduleRelationship === CANCELED) continue
    const tripId = tu.trip?.tripId || entity.id
    if (seen.has(tripId)) continue
    const scheduled = data.trips?.[tripId]
    const routeId = tu.trip?.routeId || scheduled?.route
    if (!routeId) continue
    const updates = tu.stopTimeUpdate ?? []

    let time: number | undefined
    let delay: number | undefined
    let extra: { track?: string; status?: string } = {}
    const here = updates.find(u => u.stopId === stop.id)
    if (here) {
      if (here.scheduleRelationship === SKIPPED) continue
      const event = num(here.departure?.time) !== undefined ? here.departure : here.arrival
      time = num(event?.time)
      if (typeof event?.delay === 'number' && Object.hasOwn(event, 'delay')) delay = event.delay
      extra = railroadStopTime(here)
    } else if (scheduled) {
      // Not predicted: schedule it from the last stop that is.
      const stopIds = scheduled.stops.map(([id]) => id)
      for (let i = updates.length - 1; i >= 0 && time === undefined; i--) {
        const anchorTime = num(updates[i]!.arrival?.time) ?? num(updates[i]!.departure?.time)
        const anchor = stopIds.lastIndexOf(updates[i]!.stopId ?? '')
        if (anchorTime === undefined || anchor === -1) continue
        const target = stopIds.indexOf(stop.id, anchor + 1)
        if (target === -1) break
        time = anchorTime + scheduled.stops[target]![1] - scheduled.stops[anchor]![1]
      }
    }
    if (time === undefined || time < now) continue

    seen.add(tripId)
    const route = routeInfo(data, routeId)
    arrivals.push({
      time,
      ...(delay === undefined ? {} : { delay }),
      ...extra,
      route: route.id,
      name: route.name,
      color: route.color,
      textColor: route.textColor,
      headsign: scheduled?.headsign || terminalName(updates, id => data.stops[id]?.name),
      tripId,
    })
  }
  arrivals.sort((a, b) => a.time - b.time || a.tripId.localeCompare(b.tripId))
  return {
    stop: { id: stop.id, name: stop.name },
    updatedAt: num(feed.header?.timestamp) ?? null,
    arrivals: arrivals.slice(0, limit),
  }
}
