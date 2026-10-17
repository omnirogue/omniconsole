import { describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import { proveRun, runAttempt, runSet } from '../../shared/session-run-lifecycle.test-fixture'
import {
  SESSION_OUTCOME_ATTEMPT_STALE,
  isCurrentSessionOutcomeAttempt,
  mergeSessionOutcomeAttempt
} from './session-outcome-launch-detach'

const chain = (outcomeSet: SessionOutcomeSet, extra: Partial<SessionChain> = {}): SessionChain => ({
  id: 'chn_1',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  outcomeSet,
  createdAt: 1,
  updatedAt: 2,
  ...extra
})

function lane(current: SessionChain | null) {
  const save = vi.fn((next: SessionChain) => next)
  return {
    save,
    get: (id: string): SessionChain => {
      if (!current || current.id !== id) {
        throw new Error('No committed outcome set was found.')
      }
      return current
    }
  }
}

const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'

describe('a detached launch reporting back', () => {
  it('records a checkpoint of the current attempt, and a new attempt', () => {
    const running = runAttempt({ state: 'launching' })
    const access = lane(chain({ ...runSet(), attempts: [running] }))
    mergeSessionOutcomeAttempt(access, 'chn_1', { ...running, state: 'running', updatedAt: 5 })
    mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt({ id: 'att_2', state: 'prepared' }))
    expect(access.save).toHaveBeenCalledTimes(2)
    expect(access.save.mock.calls[0]![0].outcomeSet!.attempts).toEqual([
      { ...running, state: 'running', updatedAt: 5 }
    ])
    expect(access.save.mock.calls[1]![0].outcomeSet!.attempts.map((entry) => entry.id)).toEqual([
      'att_1',
      'att_2'
    ])
  })

  it.each([
    ['a timeout', { state: 'blocked', error: STALL }],
    ['a heartbeat', { state: 'running' }],
    ['a duplicate completion', { state: 'completed' }]
  ] as const)('drops %s that arrives after the run was sealed', (_name, event) => {
    const sealed = sealSessionRunCompletion(
      { ...proveRun(runSet(), 'one'), attempts: [runAttempt({ state: 'completed' })] },
      { now: 10, operationId: 'op_seal' }
    )
    const access = lane(chain(sealed, { state: 'done' }))
    // Dropped from the record, and said to the launch so it takes no further external step.
    expect(() => mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt(event))).toThrow(
      SESSION_OUTCOME_ATTEMPT_STALE
    )
    expect(access.save).not.toHaveBeenCalled()
  })

  it('drops an event for a superseded attempt or an older plan version', () => {
    const retired = runAttempt({ state: 'superseded' })
    const access = lane(chain({ ...runSet(), attempts: [retired] }, { planVersion: 2 }))
    expect(() =>
      mergeSessionOutcomeAttempt(access, 'chn_1', { ...retired, state: 'running' })
    ).toThrow(SESSION_OUTCOME_ATTEMPT_STALE)
    expect(() =>
      mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt({ id: 'att_v1', planVersion: 1 }))
    ).toThrow(SESSION_OUTCOME_ATTEMPT_STALE)
    expect(access.save).not.toHaveBeenCalled()
    mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt({ id: 'att_v2', planVersion: 2 }))
    expect(access.save).toHaveBeenCalledTimes(1)
  })

  it('never lets a late checkpoint resurrect an attempt that completed or was retired for a retry', () => {
    for (const settled of ['completed', 'retryable'] as const) {
      const access = lane(chain({ ...runSet(), attempts: [runAttempt({ state: settled })] }))
      for (const late of [{ state: 'running' }, { state: 'blocked', error: STALL }] as const) {
        expect(() => mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt(late))).toThrow(
          SESSION_OUTCOME_ATTEMPT_STALE
        )
      }
      expect(access.save).not.toHaveBeenCalled()
      // The settled state reported once more is the same fact, not a late event.
      mergeSessionOutcomeAttempt(access, 'chn_1', runAttempt({ state: settled }))
      expect(access.save).toHaveBeenCalledTimes(1)
    }
  })

  it('drops an event for an outcome that was revised or removed, a cancelled run and a missing chain', () => {
    const revised = runSet()
    revised.outcomes[0]!.revision = 2
    expect(isCurrentSessionOutcomeAttempt(chain(revised), runAttempt())).toBe(false)
    expect(isCurrentSessionOutcomeAttempt(chain(runSet()), runAttempt({ outcomeId: 'gone' }))).toBe(
      false
    )
    expect(
      isCurrentSessionOutcomeAttempt(chain(runSet(), { state: 'cancelled' }), runAttempt())
    ).toBe(false)
    const missing = lane(null)
    expect(() => mergeSessionOutcomeAttempt(missing, 'chn_1', runAttempt())).toThrow(
      'No committed outcome set was found.'
    )
    expect(missing.save).not.toHaveBeenCalled()
  })
})
