import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS,
  deriveRunQueueAttention,
  type RunQueueFacts,
  type RunQueueSession
} from './orchestration-run-queue'

const NOW = 1_800_000_000_000
const live = (patch: Partial<RunQueueSession> = {}): RunQueueSession => ({
  status: 'live',
  agentWait: null,
  ...patch
})

function attention(patch: Partial<RunQueueFacts>): string {
  return deriveRunQueueAttention({
    taskStatus: 'dispatched',
    dispatchStatus: 'dispatched',
    workerState: 'ready',
    stage: 'input_accepted',
    session: live(),
    openQuestions: 0,
    lastActivityAtMs: NOW - 60_000,
    nowMs: NOW,
    ...patch
  }).attention
}

describe('run queue attention', () => {
  it('labels a Task with no Dispatch by its own status', () => {
    const undispatched = { dispatchStatus: null, workerState: null, session: null }
    expect(attention({ ...undispatched, taskStatus: 'ready' })).toBe('not-started')
    expect(attention({ ...undispatched, taskStatus: 'pending' })).toBe('not-started')
    expect(attention({ ...undispatched, taskStatus: 'blocked' })).toBe('blocked')
    expect(attention({ ...undispatched, taskStatus: 'failed' })).toBe('failed')
  })

  it('keeps a failed Dispatch apart from the session it ran in', () => {
    // 2026-10-03: two workers were failed input_accepted_stalled at 60 s while their sessions worked on.
    const stalled = {
      taskStatus: 'failed',
      dispatchStatus: 'failed',
      workerState: 'failed',
      stage: 'input_accepted_stalled'
    }
    const stillLive = deriveRunQueueAttention({
      ...stalled,
      session: live({ agentState: 'working' }),
      openQuestions: 0,
      lastActivityAtMs: NOW,
      nowMs: NOW
    })
    expect(stillLive.attention).toBe('failed-session-live')
    expect(stillLive.detail).toContain('input_accepted_stalled')
    expect(stillLive.detail).toContain('not a dead session')
    expect(attention({ ...stalled, session: { status: 'exited' } })).toBe('failed')
    expect(attention({ ...stalled, session: null })).toBe('failed')
    expect(attention({ ...stalled, dispatchStatus: 'circuit_broken', session: live() })).toBe(
      'failed-session-live'
    )
    // Put back to ready for a retry: waiting for its next attempt, unless the old session lives on.
    expect(attention({ ...stalled, taskStatus: 'ready', session: null })).toBe('not-started')
    expect(attention({ ...stalled, taskStatus: 'ready', session: live() })).toBe(
      'failed-session-live'
    )
  })

  it('never calls a quiet live worker anything but quiet', () => {
    const silent = NOW - ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS - 1
    const quiet = deriveRunQueueAttention({
      taskStatus: 'dispatched',
      dispatchStatus: 'dispatched',
      workerState: 'ready',
      stage: 'input_accepted',
      session: live(),
      openQuestions: 0,
      lastActivityAtMs: silent,
      nowMs: NOW
    })
    expect(quiet.attention).toBe('quiet')
    expect(quiet.detail).toContain('Quiet is not dead')
    expect(attention({ lastActivityAtMs: null })).toBe('quiet')
    expect(attention({ lastActivityAtMs: NOW - ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS })).toBe(
      'working'
    )
    // The agent's own report outranks the clock: a long tool run emits nothing.
    expect(attention({ lastActivityAtMs: silent, session: live({ agentState: 'working' }) })).toBe(
      'working'
    )
  })

  it('names who a live worker is waiting on', () => {
    expect(
      attention({ session: live({ agentWait: { source: 'hook', reason: 'permission' } }) })
    ).toBe('waiting-on-human')
    expect(attention({ session: live({ agentState: 'blocked' }) })).toBe('waiting-on-human')
    expect(attention({ session: live({ agentState: 'waiting' }) })).toBe('waiting-on-human')
    expect(attention({ openQuestions: 1 })).toBe('waiting-on-coordinator')
    expect(attention({ session: live({ agentState: 'done', providerLimited: true }) })).toBe(
      'provider-limited'
    )
    expect(attention({ session: live({ agentState: 'done', providerLimited: false }) })).toBe(
      'idle-unreported'
    )
  })

  it('reports lost contact as unverifiable and only host evidence as an exit', () => {
    for (const status of ['unverifiable', 'missing', 'identity_changed', 'unattached'] as const) {
      expect(attention({ session: { status } }), status).toBe('unverifiable')
    }
    expect(attention({ session: null })).toBe('unverifiable')
    const lost = deriveRunQueueAttention({
      taskStatus: 'dispatched',
      dispatchStatus: 'dispatched',
      workerState: 'ready',
      stage: 'input_accepted',
      session: { status: 'unverifiable', reason: 'MacBook did not answer' },
      openQuestions: 0,
      lastActivityAtMs: null,
      nowMs: NOW
    })
    expect(lost.detail).toContain('MacBook did not answer')
    expect(lost.detail).toContain('not an exit')
    expect(attention({ session: { status: 'exited' } })).toBe('exited-unreported')
  })

  it('does not guess while a worker start or stop is unsettled', () => {
    expect(attention({ workerState: 'starting' })).toBe('starting')
    for (const workerState of ['start_unknown', 'stop_unknown', 'stopping']) {
      expect(attention({ workerState }), workerState).toBe('outcome-unknown')
    }
    expect(attention({ dispatchStatus: 'completed' })).toBe('outcome-unknown')
  })
})
