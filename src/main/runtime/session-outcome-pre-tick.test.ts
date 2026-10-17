/**
 * What a host does at the top of a tick BEFORE it knows the outcomes are its own.
 *
 * An ordinary queued prompt is nobody's outcome: it is a message waiting for a conversation
 * to go idle, and every host drains its own. Delivering a prompt attached to a STAGE is not
 * that — admission and the receipt are writes to that chain's step — so it waits for the
 * ownership question, beside the continuation that commits a plan version.
 */
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  queues: 0,
  stages: 0,
  continuations: 0,
  watchdog: 0,
  watchdogClock: [] as (number | undefined)[],
  releaseClock: [] as (number | undefined)[],
  acceptance: 0
}))

vi.mock('./prompt-queue-drain', () => ({
  drainPromptQueues: async (): Promise<void> => {
    calls.queues += 1
  }
}))
vi.mock('./worker-dispatch-stall-watchdog', () => ({
  runWorkerDispatchStallWatchdog: (_runtime: unknown, nowMs?: number): number => {
    calls.watchdog += 1
    calls.watchdogClock.push(nowMs)
    return 0
  }
}))
vi.mock('./orchestration/worker-terminal-release-retry', () => ({
  retryRequestedWorkerTerminalReleases: (_runtime: unknown, nowMs?: number): void => {
    calls.releaseClock.push(nowMs)
  }
}))
vi.mock('./session-outcome-worker-acceptance', () => ({
  recoverPersistedOutcomeWorkerAcceptance: (): void => {
    calls.acceptance += 1
  }
}))
vi.mock('./up-next-stage-prompts', () => ({
  upNextHoldsStagePrompts: (): boolean => true,
  drainUpNextStagePrompts: async (): Promise<void> => {
    calls.stages += 1
  }
}))
vi.mock('./up-next-continuation', () => ({
  upNextHoldsContinuation: (): boolean => true,
  resumeUpNextContinuations: async (): Promise<void> => {
    calls.continuations += 1
  }
}))

import type { OrcaRuntimeService } from './omni-runtime'
import { runSessionOutcomePreTickWork } from './session-outcome-pre-tick'

const host = (owns: boolean): OrcaRuntimeService =>
  ({ hasSessionOutcomeContinuation: () => owns }) as unknown as OrcaRuntimeService

describe('the part of a tick before ownership', () => {
  it('leaves another host’s stage prompts and continuations alone', async () => {
    calls.queues = 0
    calls.stages = 0
    calls.continuations = 0
    calls.acceptance = 0

    expect(await runSessionOutcomePreTickWork(host(false), 'epoch-1')).toBe(false)

    expect(calls.queues).toBe(1)
    expect(calls.stages).toBe(0)
    expect(calls.continuations).toBe(0)
    expect(calls.acceptance).toBe(0)
  })

  it('drains and resumes on the host that owns them', async () => {
    calls.queues = 0
    calls.stages = 0
    calls.continuations = 0
    calls.acceptance = 0

    expect(await runSessionOutcomePreTickWork(host(true), 'epoch-1')).toBe(true)

    expect(calls.queues).toBe(1)
    expect(calls.stages).toBe(1)
    expect(calls.continuations).toBe(1)
    expect(calls.acceptance).toBe(1)
  })

  it('runs stall and release recovery on the owner host before outcome ownership', async () => {
    calls.watchdog = 0
    calls.watchdogClock = []
    calls.releaseClock = []

    await runSessionOutcomePreTickWork(host(false), 'epoch-1', 1_789_000_000_000)

    // A verdict measured from an injected clock is reproducible; the wall clock is only a default.
    expect(calls.watchdog).toBe(1)
    expect(calls.watchdogClock).toEqual([1_789_000_000_000])
    expect(calls.releaseClock).toEqual([1_789_000_000_000])
  })
})
