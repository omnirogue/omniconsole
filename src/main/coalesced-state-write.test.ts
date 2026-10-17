import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoalescedWrite, WriteRateBudget, coalescedWriteDelay } from './coalesced-state-write'

const TIMING = { debounceMs: 1_000, maxWaitMs: 5_000, burst: 3, refillMs: 10_000 }

describe('coalesced state write', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a burst of changes inside the debounce window into one write', () => {
    const write = vi.fn()
    const writer = new CoalescedWrite(TIMING, write)
    for (let i = 0; i < 50; i++) {
      writer.schedule()
      vi.advanceTimersByTime(10)
    }
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TIMING.debounceMs)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('forces a write at max-wait under a change stream that never goes quiet', () => {
    const write = vi.fn()
    const writer = new CoalescedWrite(TIMING, write)
    for (let elapsed = 0; elapsed < TIMING.maxWaitMs + 100; elapsed += 500) {
      writer.schedule()
      vi.advanceTimersByTime(500)
    }
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('bounds sustained churn to the burst plus one write per refill interval', () => {
    const write = vi.fn()
    const writer = new CoalescedWrite(TIMING, write)
    // A change every 1.5 s outlives the 1 s debounce, which alone would write 40 times a minute.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1_500) {
      writer.schedule()
      vi.advanceTimersByTime(1_500)
    }
    expect(write.mock.calls.length).toBeLessThanOrEqual(TIMING.burst + 60_000 / TIMING.refillMs)
  })

  it('flush writes a pending change at once and is a no-op when nothing is pending', () => {
    const write = vi.fn()
    const writer = new CoalescedWrite(TIMING, write)
    writer.flush()
    expect(write).not.toHaveBeenCalled()
    writer.schedule()
    writer.flush()
    expect(write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TIMING.maxWaitMs)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('refills the budget after a quiet period', () => {
    const budget = new WriteRateBudget(2, 1_000)
    budget.consume()
    budget.consume()
    expect(budget.waitMs()).toBe(1_000)
    vi.advanceTimersByTime(1_000)
    expect(budget.waitMs()).toBe(0)
  })

  it('keeps the debounce and max-wait contract when the budget allows a write', () => {
    const base = { now: 10_000, debounceMs: 1_000, maxWaitMs: 5_000, budgetWaitMs: 0 }
    expect(coalescedWriteDelay({ ...base, firstPendingAt: 10_000 })).toBe(1_000)
    expect(coalescedWriteDelay({ ...base, firstPendingAt: 5_500 })).toBe(500)
    expect(coalescedWriteDelay({ ...base, firstPendingAt: 10_000, budgetWaitMs: 7_000 })).toBe(
      7_000
    )
  })
})
