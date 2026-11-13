/**
 * The LIRR's and Metro-North's extension to GTFS-realtime stop time updates
 * (`gtfs-realtime-MTARR.proto`), read through `src/protowire.ts`.
 */
import { extension, text } from '#src/protowire.js'

// StopTimeUpdate.mta_railroad_stop_time_update = 1005: track = 1, trainStatus = 2.
const MTA_RAILROAD_STOP_TIME_UPDATE = 1005
const TRACK = 1
const TRAIN_STATUS = 2

/**
 * The track a train uses at a stop and, on Metro-North, its status there (`On-Time`, `Late`,
 * `Arriving`, `Departed`, `Bus` for a bus substitute). Either is undefined when the feed doesn't say.
 */
export function railroadStopTime(update: object): { track?: string; status?: string } {
  const ext = extension(update, MTA_RAILROAD_STOP_TIME_UPDATE)
  const track = text(ext, TRACK)?.trim()
  const status = text(ext, TRAIN_STATUS)?.trim()
  return { ...(track ? { track } : {}), ...(status ? { status } : {}) }
}
