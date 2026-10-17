import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowViewThrottle } from './workflow-view-throttle'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('workflow view throttle', () => {
  it('runs once immediately, collapses a burst and always delivers a trailing run', async () => {
    const work = vi.fn()
    const throttle = createWorkflowViewThrottle(work, 250)
    throttle.schedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(work).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 20; index++) {
      throttle.schedule()
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(work).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(work).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('never overlaps runs and reruns once when a change lands during a slow run', async () => {
    let release!: () => void
    let active = 0
    let overlapped = false
    const work = vi.fn(async () => {
      active += 1
      overlapped ||= active > 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      active -= 1
    })
    const throttle = createWorkflowViewThrottle(work, 250)
    throttle.schedule()
    await vi.advanceTimersByTimeAsync(0)
    throttle.schedule()
    throttle.schedule()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(work).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(250)
    expect(work).toHaveBeenCalledTimes(2)
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(work).toHaveBeenCalledTimes(2)
    expect(overlapped).toBe(false)
  })

  it('stops after close and survives a failing run', async () => {
    const work = vi.fn(() => {
      throw new Error('projection failed')
    })
    const throttle = createWorkflowViewThrottle(work, 250)
    throttle.schedule()
    await vi.advanceTimersByTimeAsync(0)
    throttle.schedule()
    await vi.advanceTimersByTimeAsync(250)
    expect(work).toHaveBeenCalledTimes(2)
    throttle.schedule()
    throttle.close()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(work).toHaveBeenCalledTimes(2)
  })
})
