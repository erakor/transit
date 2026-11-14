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
    await expect(memoized('k', FAIL_MS, load)).rejects.toThrow('down')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps a failure no longer than a shorter ttl', async () => {
    const load = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(memoized('k', 0, load, 1_000)).rejects.toThrow('down')
    await expect(memoized('k', 1_000, load, 1_000)).rejects.toThrow('down')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
