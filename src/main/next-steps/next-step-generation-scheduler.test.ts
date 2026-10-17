import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepGenerationScheduler } from './next-step-generation-scheduler'

type Run = { key: string; signal: AbortSignal; finish: () => void }

function harness(maxConcurrent = 2) {
  const scheduler = new NextStepGenerationScheduler({ delayMs: 1_500, maxConcurrent })
  const runs: Run[] = []
  const job = (key: string, lane = `lane-${key}`) => ({
    key,
    lane,
    run: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        runs.push({ key, signal, finish: resolve })
        signal.addEventListener('abort', () => resolve())
      })
  })
  return { scheduler, runs, job }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('NextStepGenerationScheduler', () => {
  it('waits 1.5 s after the turn, and the wait is cancelled when the pane goes busy', () => {
    const { scheduler, runs, job } = harness()
    scheduler.schedule(job('a'))
    vi.advanceTimersByTime(1_499)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs.map((run) => run.key)).toEqual(['a'])

    scheduler.schedule(job('b'))
    vi.advanceTimersByTime(700)
    expect(scheduler.cancelWaiting('b')).toBe(true)
    vi.advanceTimersByTime(5_000)
    expect(runs.map((run) => run.key)).toEqual(['a'])
    expect(scheduler.cancelWaiting('b')).toBe(false)
  })

  it('a newer job for the same conversation aborts the running one', async () => {
    const { scheduler, runs, job } = harness()
    scheduler.schedule(job('a'), { immediate: true })
    const first = runs[0]!
    scheduler.schedule(job('a'), { immediate: true })
    expect(first.signal.aborted).toBe(true)
    expect(first.signal.reason).toBe('superseded')
    await vi.runAllTimersAsync()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.signal.aborted).toBe(false)
  })

  it('never runs more than two at once and starts the next when one settles', async () => {
    const { scheduler, runs, job } = harness(2)
    for (const key of ['a', 'b', 'c']) {
      scheduler.schedule(job(key), { immediate: true })
    }
    expect(runs.map((run) => run.key)).toEqual(['a', 'b'])
    expect(scheduler.queuedCount).toBe(1)
    runs[0]!.finish()
    await vi.runAllTimersAsync()
    expect(runs.map((run) => run.key)).toEqual(['a', 'b', 'c'])
    expect(scheduler.runningCount).toBe(2)
  })

  it('holds a second call in the same workspace lane until the first settles', async () => {
    const { scheduler, runs, job } = harness(2)
    scheduler.schedule(job('a', 'repo'), { immediate: true })
    scheduler.schedule(job('b', 'repo'), { immediate: true })
    expect(runs.map((run) => run.key)).toEqual(['a'])
    runs[0]!.finish()
    await vi.runAllTimersAsync()
    expect(runs.map((run) => run.key)).toEqual(['a', 'b'])
  })

  it('the pane going busy also removes a job already queued behind the cap', () => {
    const { scheduler, runs, job } = harness(1)
    const dropped = vi.fn()
    scheduler.schedule(job('a'), { immediate: true })
    scheduler.schedule({ ...job('b'), onDropped: dropped }, { immediate: true })
    expect(scheduler.queuedCount).toBe(1)
    expect(scheduler.cancelWaiting('b')).toBe(true)
    expect(scheduler.queuedCount).toBe(0)
    expect(dropped).toHaveBeenCalledWith('busy')
    runs[0]!.finish()
    expect(runs.map((run) => run.key)).toEqual(['a'])
    // The running job is not "waiting": busy never cancels a call already under way.
    expect(scheduler.cancelWaiting('a')).toBe(false)
    expect(runs[0]!.signal.aborted).toBe(false)
  })

  it('abort cancels a job wherever it is, and admit can refuse', () => {
    const { scheduler, runs, job } = harness(1)
    scheduler.schedule(job('a'), { immediate: true })
    scheduler.schedule(job('b'), { immediate: true })
    scheduler.abort('b', 'pane-closed')
    scheduler.abort('a', 'pane-closed')
    expect(runs[0]!.signal.reason).toBe('pane-closed')
    expect(scheduler.queuedCount).toBe(0)
    scheduler.schedule({ ...job('c'), admit: () => false }, { immediate: true })
    expect(runs.map((run) => run.key)).toEqual(['a'])
  })
})
