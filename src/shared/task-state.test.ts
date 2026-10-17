import { describe, expect, it } from 'vitest'
import { isClosedTaskStatus, taskStanding, taskStandingRank } from './task-state'

const NOW = Date.parse('2026-09-12T12:00:00.000Z')

describe('task standing', () => {
  it('keeps unstarted work ready until an actor explicitly starts pursuing it', () => {
    expect(taskStanding({ status: 'open', now: NOW })).toEqual({
      state: 'ready',
      needsYou: false
    })
    expect(taskStanding({ status: 'in_progress', now: NOW }).state).toBe('in-progress')
  })

  it('separates a whole-task blocker from an attention badge', () => {
    expect(taskStanding({ status: 'blocked', now: NOW })).toEqual({
      state: 'waiting',
      needsYou: false
    })
    expect(taskStanding({ status: 'open', needsYou: true, now: NOW })).toEqual({
      state: 'ready',
      needsYou: true
    })
    expect(taskStanding({ status: 'awaiting_approval', now: NOW }).state).toBe('waiting')
    expect(taskStanding({ status: 'running', needsYou: true, now: NOW })).toEqual({
      state: 'in-progress',
      needsYou: true
    })
  })

  it('waits only on an explicit return time or pause, never on silence', () => {
    expect(
      taskStanding({ status: 'open', deferUntil: '2026-09-13T09:00:00.000Z', now: NOW }).state
    ).toBe('waiting')
    expect(
      taskStanding({ status: 'open', pausedAt: '2026-09-12T10:00:00.000Z', now: NOW }).state
    ).toBe('waiting')
    // A return time that has already passed is not waiting any more.
    expect(
      taskStanding({ status: 'open', deferUntil: '2026-09-12T09:00:00.000Z', now: NOW }).state
    ).toBe('ready')
    expect(taskStanding({ status: 'open', now: NOW }).state).toBe('ready')
  })

  it('keeps completion candidates visible for review until verification passes', () => {
    for (const status of ['candidate_complete', 'verifying', 'done']) {
      expect(taskStanding({ status, now: NOW }).state).toBe('review')
      expect(isClosedTaskStatus(status)).toBe(false)
    }
    expect(taskStanding({ status: 'verified_complete', needsYou: true })).toEqual({
      state: 'done',
      needsYou: false
    })
    expect(taskStanding({ status: 'done', verifiedAt: '2026-09-12T10:00:00Z' }).state).toBe('done')
    expect(
      taskStanding({ status: 'done', verificationFailedAt: '2026-09-12T10:00:00Z' }).state
    ).toBe('ready')
    expect(taskStanding({ status: 'cancelled' }).state).not.toBe('done')
    expect(isClosedTaskStatus('cancelled')).toBe(true)
    expect(isClosedTaskStatus('open')).toBe(false)
  })

  it('uses the server outcome projection over legacy execution and triage fields', () => {
    expect(taskStanding({ status: 'awaiting_approval', kanbanStatus: 'review' }).state).toBe(
      'review'
    )
    expect(
      taskStanding({ status: 'open', kanbanStatus: 'in_progress', triageState: 'inbox' }).state
    ).toBe('in-progress')
    expect(taskStanding({ status: 'running', kanbanStatus: 'waiting' }).state).toBe('waiting')
    expect(taskStanding({ status: 'repair_required', kanbanStatus: 'future-state' }).state).toBe(
      'ready'
    )
  })

  it('sorts what needs a person above what is moving, parked and closed', () => {
    const rank = (s: Parameters<typeof taskStanding>[0]) => taskStandingRank(taskStanding(s))
    expect(rank({ status: 'blocked', needsYou: true, now: NOW })).toBeLessThan(
      rank({ status: 'open', now: NOW })
    )
    expect(rank({ status: 'open', now: NOW })).toBeLessThan(
      rank({ status: 'open', pausedAt: 'x', now: NOW })
    )
    expect(rank({ status: 'open', pausedAt: 'x', now: NOW })).toBeLessThan(
      rank({ status: 'done', now: NOW })
    )
  })
})
