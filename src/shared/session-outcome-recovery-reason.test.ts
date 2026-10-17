import { describe, expect, it } from 'vitest'
import {
  SESSION_OUTCOME_BRIEF_TOO_LARGE,
  sessionOutcomeRecovery
} from './session-outcome-recovery-reason'

describe('what may be done with an attempt that stopped', () => {
  it('offers Retry only where a receipt proves nothing is still running', () => {
    expect(
      sessionOutcomeRecovery({ state: 'blocked', launchDisposition: 'not-started' })
    ).toMatchObject({ action: 'retry', label: 'Retry — the launch never started' })
    expect(
      sessionOutcomeRecovery({
        state: 'blocked',
        launchDisposition: 'started',
        dispatchId: 'ctx_1'
      })
    ).toMatchObject({
      reason: 'worker-dead',
      action: 'retry',
      label: 'Retry — worker confirmed dead'
    })
  })

  it('offers only Reconcile where the host cannot prove the worker stopped', () => {
    for (const attempt of [
      { state: 'unverifiable', launchDisposition: 'started', dispatchId: 'ctx_1' },
      { state: 'unverifiable' },
      { state: 'blocked', launchDisposition: 'unverifiable', dispatchId: 'ctx_1' },
      // Blocked with no disposition at all: every attempt recorded before WP-4a. Lost contact is
      // not evidence of death, so this one is reconciled by hand, never retried.
      { state: 'blocked' },
      { state: 'blocked', launchDisposition: 'started' }
    ]) {
      expect(sessionOutcomeRecovery(attempt)).toMatchObject({
        reason: 'unverifiable',
        action: 'reconcile',
        label: 'Reconcile — cannot prove it stopped'
      })
    }
  })

  it('offers nothing for an attempt that has not settled', () => {
    for (const state of [
      'prepared',
      'launching',
      'running',
      'completed',
      'retryable',
      'superseded'
    ]) {
      expect(sessionOutcomeRecovery({ state })).toBeNull()
    }
  })

  it('names the refusal a shorter brief is the only fix for', () => {
    expect(SESSION_OUTCOME_BRIEF_TOO_LARGE).toBe('brief-too-large')
  })
})
