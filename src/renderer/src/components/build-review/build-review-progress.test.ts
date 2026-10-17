import { describe, expect, it } from 'vitest'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../../shared/build-review-pipeline'
import { pipelineFixture } from './build-review-test-fixture'
import {
  buildReviewOutcome,
  buildReviewSteps,
  reviewersOutcome,
  workerVerdict
} from './build-review-progress'

function reviewer(
  status: BuildReviewWorkerSnapshot['status'],
  body: string | null = null
): BuildReviewWorkerSnapshot {
  return {
    role: 'reviewer',
    choice: { agent: 'claude' },
    status,
    taskId: null,
    dispatchId: null,
    terminalHandle: null,
    error: null,
    report:
      body === null
        ? null
        : {
            subject: 'Review',
            body,
            outcome: 'succeeded',
            filesModified: [],
            reportPath: null,
            reportedAt: '2026-09-21T12:00:00Z'
          }
  }
}

function steps(overrides: Partial<BuildReviewPipelineSnapshot>): Record<string, string> {
  return Object.fromEntries(
    buildReviewSteps(pipelineFixture(overrides)).map((step) => [step.id, step.state])
  )
}

describe('buildReviewSteps', () => {
  it('starts on Build in round one', () => {
    expect(steps({ stage: 'starting', reviewers: [reviewer('pending')] })).toEqual({
      build: 'active',
      review: 'upcoming',
      fix: 'upcoming'
    })
    expect(steps({ stage: 'building', round: 1, reviewers: [reviewer('pending')] })).toEqual({
      build: 'active',
      review: 'upcoming',
      fix: 'upcoming'
    })
  })

  it('reviews after the build, and fixes when a later round builds again', () => {
    expect(steps({ stage: 'reviewing', round: 1 })).toEqual({
      build: 'done',
      review: 'active',
      fix: 'upcoming'
    })
    expect(steps({ stage: 'building', round: 2, reviewers: [reviewer('pending')] })).toEqual({
      build: 'done',
      review: 'done',
      fix: 'active'
    })
    // Re-review after a fix: Fix is what may follow this review, never a step already behind it.
    expect(steps({ stage: 'reviewing', round: 2 })).toEqual({
      build: 'done',
      review: 'active',
      fix: 'upcoming'
    })
  })

  it('marks Fix not needed when round one was approved, and done after a repair', () => {
    expect(steps({ stage: 'completed', round: 1 })).toEqual({
      build: 'done',
      review: 'done',
      fix: 'skipped'
    })
    expect(steps({ stage: 'completed', round: 3 })).toEqual({
      build: 'done',
      review: 'done',
      fix: 'done'
    })
  })

  it('marks Fix as stopped at the round limit when the last review still asked for changes', () => {
    const changes = reviewer('succeeded', 'MAJOR: src/a.ts:1 broken\nVERDICT: REQUEST_CHANGES')
    expect(
      steps({
        stage: 'failed',
        round: 1,
        maxReviewRounds: 1,
        error: 'Review limit reached after 1 round(s); unresolved findings remain.',
        reviewers: [changes]
      })
    ).toEqual({ build: 'done', review: 'done', fix: 'round-limit' })
  })

  it('marks the step a failed or cancelled run stopped at', () => {
    expect(steps({ stage: 'failed', round: 1, reviewers: [reviewer('pending')] })).toEqual({
      build: 'failed',
      review: 'upcoming',
      fix: 'upcoming'
    })
    // Round two's fix follows round one's review, so that review stays done.
    expect(steps({ stage: 'failed', round: 2, reviewers: [reviewer('pending')] })).toEqual({
      build: 'done',
      review: 'done',
      fix: 'failed'
    })
    expect(
      steps({ stage: 'cancelled', round: 1, reviewers: [reviewer('running'), reviewer('pending')] })
    ).toEqual({ build: 'done', review: 'cancelled', fix: 'upcoming' })
    expect(steps({ stage: 'failed', round: 2, reviewers: [reviewer('failed')] })).toEqual({
      build: 'done',
      review: 'failed',
      fix: 'upcoming'
    })
  })
})

describe('verdicts', () => {
  it('reads each reviewer verdict, tolerating decoration', () => {
    expect(workerVerdict(reviewer('succeeded', '**VERDICT: APPROVE**'))).toBe('approved')
    expect(workerVerdict(reviewer('succeeded', 'VERDICT: REQUEST_CHANGES.'))).toBe(
      'changes-requested'
    )
    expect(workerVerdict(reviewer('succeeded', 'Looks fine'))).toBe('missing')
    expect(workerVerdict(reviewer('running'))).toBeNull()
    expect(workerVerdict({ ...reviewer('succeeded', 'VERDICT: APPROVE'), role: 'builder' })).toBe(
      null
    )
  })

  it('settles a round only once every reviewer reported', () => {
    const approve = reviewer('succeeded', 'VERDICT: APPROVE')
    const changes = reviewer('succeeded', 'VERDICT: REQUEST_CHANGES')
    expect(reviewersOutcome([approve, reviewer('running')])).toBeNull()
    expect(reviewersOutcome([approve, approve])).toBe('approved')
    expect(reviewersOutcome([approve, changes])).toBe('changes-requested')
    expect(reviewersOutcome([approve, reviewer('succeeded', 'no verdict')])).toBeNull()
    expect(reviewersOutcome([])).toBeNull()
  })

  it('calls a completed run approved and otherwise uses the current round', () => {
    expect(buildReviewOutcome(pipelineFixture({ stage: 'completed' }))).toBe('approved')
    expect(
      buildReviewOutcome(
        pipelineFixture({
          stage: 'failed',
          reviewers: [reviewer('succeeded', 'VERDICT: REQUEST_CHANGES')]
        })
      )
    ).toBe('changes-requested')
    expect(buildReviewOutcome(pipelineFixture({ stage: 'reviewing' }))).toBeNull()
  })

  it("follows the host's judgement over an approval beside a located blocker", () => {
    const quote = { kind: 'quote' as const, text: 'deploy on Friday', file: 'plan.md' }
    const blocker = { id: 'F1', severity: 'blocker' as const, claim: 'risky', evidence: quote }
    const approving = reviewer('succeeded', 'VERDICT: APPROVE')
    const withheld = { ...approving, findings: [{ ...blocker, status: 'located' as const }] }
    const legacy = { ...approving, findings: [{ ...blocker, status: 'not-reproduced' as const }] }
    const bare = { ...approving, findings: [{ ...blocker, status: 'needs-evidence' as const }] }
    const overruled = {
      ...reviewer('succeeded', 'VERDICT: REQUEST_CHANGES'),
      findings: [{ ...blocker, status: 'needs-evidence' as const }]
    }
    // An earlier round, as the host recorded it.
    expect(reviewersOutcome([withheld])).toBe('changes-requested')
    expect(reviewersOutcome([bare, overruled])).toBe('approved')
    // A saved not-reproduced from an earlier version fails safe.
    expect(reviewersOutcome([legacy])).toBe('changes-requested')
    const current = (reviewers: BuildReviewWorkerSnapshot[]) =>
      buildReviewOutcome(pipelineFixture({ stage: 'failed', evidenceRequired: true, reviewers }))
    expect(current([withheld])).toBe('changes-requested')
    // Settled but not yet judged: the raw verdict is not the outcome.
    expect(current([approving])).toBeNull()
    expect(current([{ ...approving, findings: null }])).toBe('approved')
  })
})
