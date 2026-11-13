/**
 * Reading protobuf extensions that `gtfs-realtime-bindings` doesn't decode. protobufjs 8 keeps
 * the bytes of fields it doesn't know in a message's `$unknowns`, one whole field (tag included)
 * per entry, and writes them back when encoding. The MTA's extensions (`gtfs-realtime-NYCT.proto`,
 * `gtfs-realtime-MTARR.proto`, `gtfs-realtime-service-status.proto`) are read from there, straight
 * from the wire format, so no `.proto` file is needed.
 */

/** A message's fields by number: varints as numbers, length-delimited fields as bytes. */
export type Fields = Map<number, (number | Uint8Array)[]>

const utf8 = new TextDecoder()

/** The fields of one encoded message. Fixed-width fields are skipped. Throws on bytes it can't read. */
function readFields(bytes: Uint8Array): Fields {
  const fields: Fields = new Map()
  let pos = 0
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      if (pos >= bytes.length) throw new Error('truncated varint')
      const b = bytes[pos++]!
      // Past 2^53 the value is wrong; the fields read here (tags, lengths, enums, bools) never get there.
      result += (b & 0x7f) * 2 ** shift
      if (b < 0x80) return result
      shift += 7
    }
  }
  const add = (field: number, value: number | Uint8Array) => {
    const values = fields.get(field)
    if (values) values.push(value)
    else fields.set(field, [value])
  }
  while (pos < bytes.length) {
    const tag = varint()
    const wireType = tag % 8
    const field = Math.floor(tag / 8)
    if (wireType === 0) add(field, varint())
    else if (wireType === 1) pos += 8
    else if (wireType === 5) pos += 4
    else if (wireType === 2) {
      const len = varint()
      if (pos + len > bytes.length) throw new Error('truncated field')
      add(field, bytes.subarray(pos, pos + len))
      pos += len
    } else throw new Error(`unsupported wire type ${wireType}`)
    if (pos > bytes.length) throw new Error('truncated field')
  }
  return fields
}

/**
 * The fields of extension `field` on a decoded message, from its `$unknowns`; undefined when the
 * message doesn't carry it or its bytes can't be read. Extensions only add detail, so a broken
 * one never fails the response.
 */
export function extension(message: object | null | undefined, field: number): Fields | undefined {
  const unknowns = (message as { $unknowns?: Uint8Array[] } | null | undefined)?.$unknowns
  if (!unknowns) return undefined
  for (const bytes of unknowns) {
    // Each entry is read on its own: another extension that can't be read doesn't hide this one.
    try {
      const value = readFields(bytes).get(field)?.[0]
      if (value instanceof Uint8Array) return readFields(value)
    } catch {
      continue
    }
  }
  return undefined
}

/** A string field's value; undefined when absent, empty or not a string. */
export function text(fields: Fields | undefined, field: number): string | undefined {
  const v = fields?.get(field)?.[0]
  return v instanceof Uint8Array ? utf8.decode(v) || undefined : undefined
}

/** A varint field's value (bools and enums included); undefined when absent. */
export function varint(fields: Fields | undefined, field: number): number | undefined {
  const v = fields?.get(field)?.[0]
  return typeof v === 'number' ? v : undefined
}
