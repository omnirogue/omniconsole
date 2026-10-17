/**
 * What work held behind a person review makes of a run that is otherwise done, and how a review
 * receipt is read. Pure: the stamp is the terminal writer's, and this is the one reading of it.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_RECOVERING_MAX_MS } from './session-outcome-block'
import {
  SESSION_RUN_CONTINUATION_CODES,
  readSessionRunHeldContinuation,
  sessionReviewDecision,
  sessionReviewFixRunning,
  sessionReviewReceiptReply,
  sessionRunHeldContinuationSchema,
  spentSessionReviewReceipts,
  type SessionRunHeldContinuation,
  type SessionRunReviewFix
} from './session-run-held-continuation'

const NOW = 50_000_000
const CHANGES = 'handoff-review:hth_uma:hrv_1:request_changes'

const fix = (over: Partial<SessionRunReviewFix> = {}): SessionRunReviewFix => ({
  receipt: CHANGES,
  stepId: 'review',
  employeeId: 'emp_uma',
  round: 1,
  note: 'Tighten the intro.',
  at: NOW,
  ...over
})

const hold = (over: Partial<SessionRunHeldContinuation> = {}): SessionRunHeldContinuation => ({
  reviewStepIds: ['review'],
  since: NOW,
  ...over
})

describe('reading a review receipt', () => {
  it('reads the thread, the reply and the decision the verifier wrote', () => {
    expect(sessionReviewReceiptReply(CHANGES)).toEqual({
      threadId: 'hth_uma',
      reviewId: 'hrv_1',
      decision: 'request_changes'
    })
    expect(sessionReviewDecision(CHANGES)).toBe('request_changes')
    expect(sessionReviewDecision('handoff-review:hth_uma:hrv_2:approve')).toBe('approve')
  })

  it('counts any other answer the host recorded as an OK, never as a request for changes', () => {
    expect(sessionReviewReceiptReply('user-review:emp_1')).toBeNull()
    expect(sessionReviewDecision('user-review:emp_1')).toBe('approve')
  })
})

describe('the phase held work gives a run that is otherwise done', () => {
  it('is active while the host starts the work every reviewer approved', () => {
    expect(readSessionRunHeldContinuation(hold(), NOW + 1_000)).toEqual({ phase: 'active' })
  })

  it('reads a refused start as recovering, with the refusal as its diagnostic', () => {
    expect(
      readSessionRunHeldContinuation(hold({ refused: 'upNext.refusal.needsAgent' }), NOW)
    ).toEqual({
      phase: 'recovering',
      code: SESSION_RUN_CONTINUATION_CODES.refused,
      reason: 'upNext.refusal.needsAgent'
    })
  })

  it('fails honestly once a release has stood for the recovering maximum', () => {
    const later = NOW + SESSION_RECOVERING_MAX_MS + 1
    expect(readSessionRunHeldContinuation(hold(), later)).toEqual({
      phase: 'failed',
      code: SESSION_RUN_CONTINUATION_CODES.held
    })
    expect(readSessionRunHeldContinuation(hold({ refused: 'Refused.' }), later)).toEqual({
      phase: 'failed',
      code: SESSION_RUN_CONTINUATION_CODES.refused,
      reason: 'Refused.'
    })
  })

  it('measures a refusal from when it appeared, not from when the run was otherwise done', () => {
    // The fix turn ran for twice the recovering maximum; one reading at its end was refused.
    const appeared = NOW + 2 * SESSION_RECOVERING_MAX_MS
    const refused = hold({
      refused: 'Pane not found.',
      refusedSince: appeared,
      fixes: [fix({ promptId: 'review-fix-1', deliveredAt: NOW })]
    })
    expect(readSessionRunHeldContinuation(refused, appeared + 1_000)).toEqual({
      phase: 'recovering',
      code: SESSION_RUN_CONTINUATION_CODES.refused,
      reason: 'Pane not found.'
    })
    expect(
      readSessionRunHeldContinuation(refused, appeared + SESSION_RECOVERING_MAX_MS + 1)
    ).toMatchObject({ phase: 'failed', code: SESSION_RUN_CONTINUATION_CODES.refused })
  })

  it('stays active while the agent fixes what a reviewer asked for, however long it takes', () => {
    const later = NOW + 10 * SESSION_RECOVERING_MAX_MS
    const waiting = hold({ fixes: [fix()] })
    const running = hold({ fixes: [fix({ promptId: 'review-fix-1', deliveredAt: NOW })] })
    expect(readSessionRunHeldContinuation(waiting, later)).toEqual({ phase: 'active' })
    expect(readSessionRunHeldContinuation(running, later)).toEqual({ phase: 'active' })
    expect(sessionReviewFixRunning(waiting)).toBe(false)
    expect(sessionReviewFixRunning(running)).toBe(true)
  })

  it('fails when the notes could not be handed to the agent, which is never retried', () => {
    expect(
      readSessionRunHeldContinuation(hold({ fixes: [fix({ failed: 'Pane closed.' })] }), NOW)
    ).toEqual({
      phase: 'failed',
      code: SESSION_RUN_CONTINUATION_CODES.fixFailed,
      reason: 'Pane closed.'
    })
  })

  it('reads a fix whose reviewer was asked again as history, not as work in progress', () => {
    const asked = hold({ fixes: [fix({ deliveredAt: NOW, reaskedAt: NOW + 5 })] })
    expect(sessionReviewFixRunning(asked)).toBe(false)
    expect(readSessionRunHeldContinuation(asked, NOW + 1)).toEqual({ phase: 'active' })
  })
})

describe('the stamp the set carries', () => {
  it('names every answer a re-ask retired as spent, beside the replies it fixed', () => {
    const approved = 'handoff-review:hth_iris:hrv_2:approve'
    const stamp = hold({
      fixes: [fix({ reaskedAt: NOW + 5 }), fix({ receipt: 'handoff-review:hth_b:hrv_9:approve' })],
      superseded: [approved]
    })
    expect(sessionRunHeldContinuationSchema.safeParse(stamp).success).toBe(true)
    // An open fix is still the run's work; its reply is not spent until its reviewer is re-asked.
    expect([...spentSessionReviewReceipts(stamp)]).toEqual([CHANGES, approved])
    expect(spentSessionReviewReceipts(undefined).size).toBe(0)
  })

  it('accepts the record of a reply and refuses one it cannot read back', () => {
    expect(sessionRunHeldContinuationSchema.safeParse(hold({ fixes: [fix()] })).success).toBe(true)
    expect(sessionRunHeldContinuationSchema.safeParse({ reviewStepIds: [] }).success).toBe(false)
    expect(
      sessionRunHeldContinuationSchema.safeParse(hold({ fixes: [{ ...fix(), extra: 1 } as never] }))
        .success
    ).toBe(false)
  })
})
