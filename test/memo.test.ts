import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFeedMemo, FAIL_MS, memoized } from '#src/memo.js'

beforeEach(clearFeedMemo)

describe('memoized', () => {
  it('reuses a result within its ttl and loads again after it', async () => {
    const load = vi.fn(async () => 'a')
    await memoized('k', 0, load, 1_000)
    await memoized('k', 999, load, 1_000)
    expect(load).toHaveBeenCalledTimes(1)
    await memoized('k', 1_000, load, 1_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reuses a failure within FAIL_MS and retries after it', async () => {
    const load = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(memoized('k', 0, load)).rejects.toThrow('down')
    await expect(memoized('k', FAIL_MS - 1, load)).rejects.toThrow('down')
    expect(load).toHaveBeenCalledTimes(1)
    await expect(memoized('k', FAIL_MS + 500, load)).rejects.toThrow('down')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('counts the failure window from when a slow load fails', async () => {
    vi.useFakeTimers()
    try {
      const load = vi.fn(
        () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000))
      )
      const first = expect(memoized('k', 0, load)).rejects.toThrow('timeout')
      await vi.advanceTimersByTimeAsync(8_000)
      await first
      // The caller's clock reads 8 s on the next request: still inside the window that began at the failure.
      await expect(memoized('k', 8_000, load)).rejects.toThrow('timeout')
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a failure no longer than a shorter ttl', async () => {
    const load = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(memoized('k', 0, load, 1_000)).rejects.toThrow('down')
    await expect(memoized('k', 1_500, load, 1_000)).rejects.toThrow('down')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
