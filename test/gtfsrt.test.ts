import { describe, expect, it } from 'vitest'
import { readLimited, readLimitedJson } from '#src/memo.js'

/** A body that arrives in `chunks` of `size` bytes, without a Content-Length unless given one. */
function streamed(total: number, size: number, headers?: HeadersInit): Response {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close()
      const n = Math.min(size, total - sent)
      controller.enqueue(new Uint8Array(n).fill(1))
      sent += n
    },
  })
  return new Response(body, { headers })
}

describe('readLimited', () => {
  it('returns a body under the cap', async () => {
    const bytes = await readLimited(new Response('hello'), 10)
    expect(new TextDecoder().decode(bytes)).toBe('hello')
  })

  it('accepts a body exactly at the cap, and an empty one', async () => {
    expect((await readLimited(streamed(10, 3), 10)).byteLength).toBe(10)
    expect((await readLimited(new Response(null), 10)).byteLength).toBe(0)
  })

  it('rejects early on a Content-Length over the cap, without reading the body', async () => {
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true
      },
    })
    const res = new Response(body, { headers: { 'content-length': '11' } })
    await expect(readLimited(res, 10)).rejects.toThrow('upstream body over 10 bytes')
    expect(pulled).toBe(false)
  })

  it('rejects a streamed body over the cap that has no Content-Length, and stops reading', async () => {
    const res = streamed(1000, 4)
    await expect(readLimited(res, 10)).rejects.toThrow('upstream body over 10 bytes')
  })

  it('rejects a body longer than its Content-Length says', async () => {
    await expect(readLimited(streamed(50, 5, { 'content-length': '5' }), 10)).rejects.toThrow('over 10 bytes')
  })

  it('keeps the request URL out of the error', async () => {
    const res = new Response('x'.repeat(20))
    Object.defineProperty(res, 'url', { value: 'https://bustime.example/?key=SECRET' })
    const err = await readLimited(res, 10).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/SECRET|bustime|https:/)
  })
})

describe('readLimitedJson', () => {
  it('parses a body under the cap and rejects one over it', async () => {
    expect(await readLimitedJson(new Response('{"a":[1,2]}'), 20)).toEqual({ a: [1, 2] })
    await expect(readLimitedJson(new Response('{"a":[1,2]}'), 5)).rejects.toThrow('over 5 bytes')
  })
})
