import { describe, expect, it } from 'vitest'
import {
  SESSION_RECOVERY_BACKOFF_MS,
  SESSION_RECOVERY_DEADLINE_MS,
  SESSION_RECOVERY_MAX_AUTO_RETRIES,
  SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS,
  SESSION_RECOVERY_USAGE_BACKOFF_MS,
  decideSessionAttemptRecovery,
  sessionAttemptAwaitingSchema,
  sessionAttemptFailureCode,
  sessionAttemptFailureSchema,
  type SessionAttemptFailureCode,
  type SessionAttemptRecoveryInput
} from './session-attempt-recovery'

const FAILED_AT = 50_000_000
type Attempt = SessionAttemptRecoveryInput['attempt']

/** A worker that started, was dispatched, and stopped: provably dead once its receipt is settled. */
const stopped = (code: SessionAttemptFailureCode = 'worker-stalled', detail?: string): Attempt => ({
  state: 'blocked',
  launchDisposition: 'started',
  dispatchId: 'dispatch_1',
  failure: { code, at: FAILED_AT, ...(detail ? { detail } : {}) },
  // Later than the failure on purpose: the ladder must time from the failure, not the last write.
  updatedAt: FAILED_AT + 999_999
})

const decide = (input: Partial<SessionAttemptRecoveryInput> = {}) =>
  decideSessionAttemptRecovery({
    attempt: stopped(),
    retriesUsed: 0,
    workerSettled: true,
    now: FAILED_AT,
    ...input
  })

describe('what is recoverable at all', () => {
  it('decides nothing for an attempt that has not stopped', () => {
    for (const state of [
      'prepared',
      'launching',
      'running',
      'completed',
      'retryable',
      'superseded'
    ]) {
      expect(decide({ attempt: { ...stopped(), state } })).toEqual({ kind: 'none' })
    }
  })

  it('reads the failure code from the record, falling back to what the launch says', () => {
    expect(sessionAttemptFailureCode(stopped('worker-exited'))).toBe('worker-exited')
    expect(
      sessionAttemptFailureCode({
        state: 'blocked',
        launchDisposition: 'not-started',
        updatedAt: 1
      })
    ).toBe('launch-not-started')
    expect(
      sessionAttemptFailureCode({ state: 'blocked', launchDisposition: 'started', updatedAt: 1 })
    ).toBe('unknown')
  })

  it('accepts only machine ids as a failure detail, and only a real prompt as awaiting', () => {
    const failure = { code: 'startup-blocked', at: 1 }
    expect(
      sessionAttemptFailureSchema.safeParse({ ...failure, detail: 'codex-hooks-review-prompt' })
        .success
    ).toBe(true)
    expect(
      sessionAttemptFailureSchema.safeParse({ ...failure, detail: 'No activity was observed' })
        .success
    ).toBe(false)
    expect(sessionAttemptFailureSchema.safeParse({ code: 'needs-you', at: 1 }).success).toBe(false)
    expect(
      sessionAttemptAwaitingSchema.safeParse({ kind: 'clarification', prompt: ' ', since: 1 })
        .success
    ).toBe(false)
    expect(
      sessionAttemptAwaitingSchema.safeParse({ kind: 'permission', prompt: 'Run it?', since: 1 })
        .success
    ).toBe(true)
  })
})

describe('relaunching only what is provably safe to relaunch', () => {
  const notStarted: Attempt = {
    state: 'blocked',
    launchDisposition: 'not-started',
    updatedAt: FAILED_AT
  }

  it('retries a launch that never started, without any worker proof', () => {
    expect(decide({ attempt: notStarted, workerSettled: false })).toEqual({
      kind: 'wait',
      rung: 0,
      until: FAILED_AT + SESSION_RECOVERY_BACKOFF_MS[0]
    })
    expect(
      decide({
        attempt: notStarted,
        workerSettled: false,
        now: FAILED_AT + SESSION_RECOVERY_BACKOFF_MS[0]
      })
    ).toEqual({ kind: 'retry', rung: 0 })
  })

  it('retries a dead worker only once its receipt is settled', () => {
    const due = FAILED_AT + SESSION_RECOVERY_BACKOFF_MS[0]
    expect(decide({ now: due, workerSettled: true })).toEqual({ kind: 'retry', rung: 0 })
    expect(decide({ now: due, workerSettled: false })).toEqual({
      kind: 'hold',
      until: FAILED_AT + SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS
    })
    // A settled receipt with no dispatch to attribute it to proves nothing about this attempt.
    const { dispatchId: _dispatch, ...undispatched } = stopped()
    expect(decide({ attempt: undispatched, now: due, workerSettled: true }).kind).toBe('hold')
  })

  it('holds an unverifiable worker, then fails honestly, and never relaunches it', () => {
    const records: Attempt[] = [
      { ...stopped(), state: 'unverifiable' },
      { ...stopped(), launchDisposition: 'unverifiable' }
    ]
    const grace = FAILED_AT + SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS
    for (const attempt of records) {
      expect(decide({ attempt, workerSettled: false, now: grace - 1 })).toEqual({
        kind: 'hold',
        until: grace
      })
      expect(decide({ attempt, workerSettled: false, now: grace })).toEqual({
        kind: 'fail',
        code: 'unverifiable-worker',
        because: 'unsafe'
      })
      // A person's Resume lifts the bound and the deadline, never the safety proof.
      for (const now of [FAILED_AT, grace - 1, grace, grace + SESSION_RECOVERY_DEADLINE_MS]) {
        for (const retriesUsed of [0, 1, SESSION_RECOVERY_MAX_AUTO_RETRIES, 9]) {
          for (const userInitiated of [false, true]) {
            const decision = decide({
              attempt,
              workerSettled: false,
              now,
              retriesUsed,
              userInitiated
            })
            expect(['hold', 'fail']).toContain(decision.kind)
          }
        }
      }
      expect(decide({ attempt, workerSettled: false, userInitiated: true })).toEqual({
        kind: 'fail',
        code: 'unverifiable-worker',
        because: 'unsafe'
      })
    }
  })
})

describe('the bounded ladder', () => {
  it('waits out each backoff before its retry', () => {
    SESSION_RECOVERY_BACKOFF_MS.forEach((backoff, rung) => {
      const until = FAILED_AT + backoff
      expect(decide({ retriesUsed: rung, now: until - 1 })).toEqual({ kind: 'wait', rung, until })
      expect(decide({ retriesUsed: rung, now: until })).toEqual({ kind: 'retry', rung })
    })
    expect(SESSION_RECOVERY_BACKOFF_MS).toHaveLength(SESSION_RECOVERY_MAX_AUTO_RETRIES)
  })

  it('times the backoff from the last write when an older record carries no failure', () => {
    const { failure: _failure, ...legacy } = stopped()
    const until = legacy.updatedAt + SESSION_RECOVERY_BACKOFF_MS[0]
    expect(decide({ attempt: legacy, now: until - 1 })).toEqual({ kind: 'wait', rung: 0, until })
  })

  it('fails as exhausted at the bound: running out of retries asks nobody anything', () => {
    for (const code of [
      'worker-stalled',
      'worker-exited',
      'agent-turn-failed',
      'unknown'
    ] as const) {
      for (const retriesUsed of [SESSION_RECOVERY_MAX_AUTO_RETRIES, 7]) {
        expect(decide({ attempt: stopped(code), retriesUsed, now: FAILED_AT + 3_600_000 })).toEqual(
          { kind: 'fail', code, because: 'exhausted' }
        )
      }
    }
  })

  it('never relaunches a failure older than the deadline', () => {
    expect(decide({ now: FAILED_AT + SESSION_RECOVERY_DEADLINE_MS })).toEqual({
      kind: 'retry',
      rung: 0
    })
    expect(decide({ now: FAILED_AT + SESSION_RECOVERY_DEADLINE_MS + 1 })).toEqual({
      kind: 'fail',
      code: 'worker-stalled',
      because: 'deadline'
    })
  })

  it("lifts the bound and the deadline, and skips the backoff, on a person's Resume", () => {
    expect(
      decide({
        userInitiated: true,
        retriesUsed: 9,
        now: FAILED_AT + 10 * SESSION_RECOVERY_DEADLINE_MS
      })
    ).toEqual({ kind: 'retry', rung: 9 })
    expect(decide({ userInitiated: true })).toEqual({ kind: 'retry', rung: 0 })
  })
})

describe('requirements only a person can meet', () => {
  it('gives a usage wall its own longer backoff, then asks', () => {
    const attempt = stopped('provider-usage-limit')
    SESSION_RECOVERY_USAGE_BACKOFF_MS.forEach((backoff, rung) => {
      const until = FAILED_AT + backoff
      expect(backoff).toBeGreaterThan(SESSION_RECOVERY_BACKOFF_MS[rung]!)
      expect(decide({ attempt, retriesUsed: rung, now: until - 1 })).toEqual({
        kind: 'wait',
        rung,
        until
      })
      expect(decide({ attempt, retriesUsed: rung, now: until })).toEqual({ kind: 'retry', rung })
    })
    expect(decide({ attempt, retriesUsed: SESSION_RECOVERY_MAX_AUTO_RETRIES })).toEqual({
      kind: 'attention',
      requirement: 'provider-usage-limit',
      code: 'provider-usage-limit'
    })
  })

  it('asks for a sign-in at once, and tries again only when the person says they signed in', () => {
    const attempt = stopped('provider-authentication')
    const ask = {
      kind: 'attention',
      requirement: 'provider-authentication',
      code: 'provider-authentication'
    }
    expect(decide({ attempt })).toEqual(ask)
    expect(decide({ attempt, workerSettled: false })).toEqual(ask)
    expect(decide({ attempt, userInitiated: true })).toEqual({ kind: 'retry', rung: 0 })
    expect(decide({ attempt, userInitiated: true, workerSettled: false }).kind).toBe('fail')
  })

  it('asks for a shorter stage at once, and tries again only when the person says they shortened it', () => {
    // Refused before anything was dispatched: the launch never started.
    const attempt: Attempt = {
      state: 'blocked',
      launchDisposition: 'not-started',
      failure: { code: 'brief-too-large', at: FAILED_AT },
      updatedAt: FAILED_AT
    }
    const ask = { kind: 'attention', requirement: 'brief-too-large', code: 'brief-too-large' }
    expect(decide({ attempt, workerSettled: false })).toEqual(ask)
    // No automatic retry sends a smaller brief, however long the host waits.
    expect(
      decide({ attempt, workerSettled: false, now: FAILED_AT + SESSION_RECOVERY_DEADLINE_MS })
    ).toEqual(ask)
    expect(decide({ attempt, workerSettled: false, userInitiated: true })).toEqual({
      kind: 'retry',
      rung: 0
    })
  })

  it.each([
    'codex-hooks-review-prompt',
    'codex-trust-workspace',
    'codex-interactive-prompt',
    'agent-approval-prompt'
  ])('asks about the %s startup prompt only after automatic remediation is exhausted', (detail) => {
    const attempt = stopped('startup-blocked', detail)
    expect(decide({ attempt }).kind).toBe('wait')
    expect(decide({ attempt, now: FAILED_AT + SESSION_RECOVERY_BACKOFF_MS[0] })).toEqual({
      kind: 'retry',
      rung: 0
    })
    expect(decide({ attempt, retriesUsed: SESSION_RECOVERY_MAX_AUTO_RETRIES })).toEqual({
      kind: 'attention',
      requirement: 'provider-approval',
      code: 'startup-blocked'
    })
  })

  it('fails any other startup block once exhausted: a person cannot clear it either', () => {
    for (const detail of ['codex-update-available', undefined]) {
      expect(
        decide({
          attempt: stopped('startup-blocked', detail),
          retriesUsed: SESSION_RECOVERY_MAX_AUTO_RETRIES
        })
      ).toEqual({ kind: 'fail', code: 'startup-blocked', because: 'exhausted' })
    }
  })

  it('never restarts a worker its person closed, until they ask for it', () => {
    const attempt = stopped('operator-closed')
    const cancelled = { kind: 'fail', code: 'operator-closed', because: 'cancelled' }
    expect(decide({ attempt })).toEqual(cancelled)
    expect(decide({ attempt, workerSettled: false })).toEqual(cancelled)
    expect(decide({ attempt, now: FAILED_AT + SESSION_RECOVERY_BACKOFF_MS[0] })).toEqual(cancelled)
    expect(decide({ attempt, userInitiated: true })).toEqual({ kind: 'retry', rung: 0 })
    expect(decide({ attempt, userInitiated: true, workerSettled: false })).toEqual({
      kind: 'fail',
      code: 'unverifiable-worker',
      because: 'unsafe'
    })
  })
})
