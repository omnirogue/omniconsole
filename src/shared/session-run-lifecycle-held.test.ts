/**
 * The phase table for a run with work held behind its own person review (owner's ruling F): it
 * reads `waiting` on the people while it waits for their OK, `active` while the agent fixes the work
 * or the host releases what was held, and never `needs-you` for the sender, never `completed`.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_RECOVERING_MAX_MS } from './session-outcome-block'
import type { SessionOutcomeSet } from './session-outcome-types'
import { sealSessionRunCompletion } from './session-run-completion'
import type {
  SessionRunHeldContinuation,
  SessionRunReviewFix
} from './session-run-held-continuation'
import { readSessionRun } from './session-run-lifecycle'
import { blockRunOutcome, proveRun, runSet } from './session-run-lifecycle.test-fixture'

const NOW = 20_000_000
const REVIEW = 'The requested person has not returned a review of the current file versions.'

const fix = (over: Partial<SessionRunReviewFix> = {}): SessionRunReviewFix => ({
  receipt: 'handoff-review:hth_uma:hrv_1:request_changes',
  stepId: 'review',
  employeeId: 'emp_uma',
  round: 1,
  note: 'Tighten the intro.',
  at: NOW,
  ...over
})

const held = (
  set: SessionOutcomeSet,
  over: Partial<SessionRunHeldContinuation> = {}
): SessionOutcomeSet => ({
  ...set,
  heldContinuation: { reviewStepIds: ['review'], ...over }
})

const proven = (): SessionOutcomeSet => proveRun(runSet(), 'one')

/** The review still waits on a reviewer: the verification hold the recompute writes. */
const waitingOn = (name: string): SessionOutcomeSet =>
  blockRunOutcome(runSet(), 'one', REVIEW, {
    class: 'waiting',
    code: 'person-review',
    since: NOW,
    wake: name
  })

describe('a run with work held behind its own review', () => {
  it('waits on the named reviewer while their OK is out', () => {
    expect(readSessionRun(held(waitingOn('Uma Evans')), { now: NOW })).toMatchObject({
      phase: 'waiting',
      wake: 'Uma Evans',
      attention: []
    })
  })

  it('is active, never completed, once every reviewer approved and the work is not released yet', () => {
    expect(readSessionRun(held(proven(), { since: NOW }), { now: NOW + 1 })).toMatchObject({
      phase: 'active',
      lifecycle: 'waiting',
      satisfied: 1,
      total: 1,
      attention: []
    })
    // Without anything held, the same proof completes the run.
    expect(readSessionRun(proven(), { now: NOW }).phase).toBe('completed')
  })

  it('is active while the agent fixes what a reviewer asked for, even with another reply out', () => {
    const fixing = { fixes: [fix({ promptId: 'review-fix-1', deliveredAt: NOW })] }
    expect(readSessionRun(held(proven(), { since: NOW, ...fixing }), { now: NOW }).phase).toBe(
      'active'
    )
    expect(readSessionRun(held(waitingOn('Iris Allen'), fixing), { now: NOW }).phase).toBe('active')
  })

  it('reads a refused release as recovering with the refusal under Details, then as failed', () => {
    const refused = held(proven(), { since: NOW, refused: 'upNext.refusal.needsAgent' })
    expect(readSessionRun(refused, { now: NOW + 1 })).toMatchObject({
      phase: 'recovering',
      reasons: ['upNext.refusal.needsAgent']
    })
    expect(readSessionRun(refused, { now: NOW + SESSION_RECOVERING_MAX_MS + 1 })).toMatchObject({
      phase: 'failed',
      failure: {
        outcomeId: 'one',
        code: 'continuation-refused',
        reason: 'upNext.refusal.needsAgent'
      }
    })
  })

  it('fails honestly when the work every reviewer approved is never started', () => {
    expect(
      readSessionRun(held(proven(), { since: NOW }), { now: NOW + SESSION_RECOVERING_MAX_MS + 1 })
    ).toMatchObject({ phase: 'failed', failure: { code: 'continuation-held' } })
  })

  it('fails when the reviewer’s notes could not be handed to the agent', () => {
    const broken = held(proven(), { since: NOW, fixes: [fix({ failed: 'Pane closed.' })] })
    expect(readSessionRun(broken, { now: NOW })).toMatchObject({
      phase: 'failed',
      failure: { code: 'review-fix-failed', reason: 'Pane closed.' }
    })
  })

  it('leaves a sealed run completed, whatever a stamp beside the seal says', () => {
    const sealed = sealSessionRunCompletion(proven(), { now: NOW, operationId: 'op_seal' })
    expect(readSessionRun(held(sealed, { since: NOW }), { now: NOW }).phase).toBe('completed')
  })
})
