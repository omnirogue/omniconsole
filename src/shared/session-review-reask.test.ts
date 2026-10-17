/**
 * The re-ask contract (owner's ruling C), shared with the delivery half: the thread is kept, the
 * delivery goes back to `pending` under a FRESH key, the round goes up by one, the rule says it is a
 * re-ask, and the capture starts over under the same summary name. Old rules load unchanged.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain } from './session-chain-types'
import { normalizeSessionFollowUpRule, type SessionFollowUpRule } from './session-follow-up-rule'
import type { SessionOutcomeEvidence } from './session-outcome-types'
import {
  spentSessionReviewReceipts,
  type SessionRunReviewFix
} from './session-run-held-continuation'
import { reaskSessionFollowUpRecipients, reaskSessionReview } from './session-review-reask'

const SHA = 'a'.repeat(64)
const CHANGES = 'handoff-review:hth_uma:hrv_1:request_changes'
const APPROVED = 'handoff-review:hth_iris:hrv_2:approve'

function rule(): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: null,
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      {
        employeeId: 'emp_uma',
        name: 'Uma Evans',
        operationId: 'op_uma_first',
        delivery: 'sent',
        threadId: 'hth_uma',
        error: 'An earlier replay timed out.',
        at: 10
      },
      {
        employeeId: 'emp_iris',
        name: 'Iris Allen',
        operationId: 'op_iris_first',
        delivery: 'sent',
        threadId: 'hth_iris',
        at: 11
      }
    ],
    action: 'review',
    disposition: 'feedback',
    deliverables: { kind: 'files', paths: [] },
    includeSummary: true,
    note: 'Please review',
    savedAt: 1,
    capturedAt: 5,
    files: [{ name: 'Summary - intro.md', sha256: SHA, size: 3, sourcePath: null }],
    summaryMarkdown: 'Old',
    summaryFile: 'Summary - intro.md'
  }
}

const receipt = (id: string, conditionId: string, text: string): SessionOutcomeEvidence => ({
  id,
  outcomeId: 'o1',
  conditionId,
  outcomeRevision: 1,
  conditionKey: 'k',
  kind: 'review',
  target: conditionId,
  receipt: text,
  verifiedAt: 30,
  verifier: 'execution-host'
})

function chain(): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [{ id: 'review', kind: 'handoff', status: 'delivered', handoff: rule() }],
    currentIndex: 1,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [
        {
          id: 'o1',
          title: 'Intro reviewed',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['review'],
          conditions: [
            { id: 'uma', kind: 'review', target: 'emp_uma', recipientId: 'emp_uma' },
            { id: 'iris', kind: 'review', target: 'emp_iris', recipientId: 'emp_iris' }
          ],
          actions: [],
          revision: 1,
          status: 'satisfied',
          evidence: [receipt('ev_uma', 'uma', CHANGES), receipt('ev_iris', 'iris', APPROVED)]
        }
      ],
      removals: [],
      attempts: [],
      completedSteps: ['review'],
      heldContinuation: {
        reviewStepIds: ['review'],
        fixes: [fix()]
      },
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 3
    }
  }
}

function fix(): SessionRunReviewFix {
  return {
    receipt: CHANGES,
    stepId: 'review',
    employeeId: 'emp_uma',
    round: 1,
    note: 'Tighten the intro.',
    at: 40,
    promptId: 'review-fix-1',
    turnVersion: 'turn-1',
    deliveredAt: 41
  }
}

describe('asking a reviewer again', () => {
  it('keeps the thread, mints a fresh key, raises the round and starts the capture over', () => {
    const asked = reaskSessionFollowUpRecipients(rule(), ['emp_uma'], () => 'op_uma_second')
    expect(asked.reask).toBe(true)
    expect(asked.recipients[0]).toEqual({
      employeeId: 'emp_uma',
      name: 'Uma Evans',
      operationId: 'op_uma_second',
      delivery: 'pending',
      round: 2,
      threadId: 'hth_uma',
      at: 10
    })
    // Somebody who was not asked again is exactly as they were.
    expect(asked.recipients[1]).toEqual(rule().recipients[1])
    expect(asked.capturedAt).toBeUndefined()
    expect(asked.files).toBeUndefined()
    expect(asked.summaryMarkdown).toBeUndefined()
    expect(asked.summaryFile).toBe('Summary - intro.md')
    // A third round counts on from the second.
    const third = reaskSessionFollowUpRecipients(asked, ['emp_uma'], () => 'op_uma_third')
    expect(third.recipients[0]).toMatchObject({ round: 3, operationId: 'op_uma_third' })
  })

  it('survives a reload with its round, its re-ask mark and the summary name it will reuse', () => {
    const asked = reaskSessionFollowUpRecipients(rule(), ['emp_uma'], () => 'op_uma_second')
    const loaded = normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(asked)))!
    expect(loaded.reask).toBe(true)
    expect(loaded.recipients[0]).toMatchObject({
      round: 2,
      delivery: 'pending',
      threadId: 'hth_uma',
      operationId: 'op_uma_second'
    })
    expect(loaded.summaryFile).toBe('Summary - intro.md')
    expect(loaded.capturedAt).toBeUndefined()
  })

  it('loads a rule written before rounds existed exactly as before', () => {
    const loaded = normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(rule())))!
    expect(loaded.reask).toBeUndefined()
    expect(loaded.recipients.map((recipient) => recipient.round)).toEqual([undefined, undefined])
    expect(loaded.summaryFile).toBe('Summary - intro.md')
    expect(
      normalizeSessionFollowUpRule({
        ...rule(),
        recipients: [{ ...rule().recipients[0], round: 0 }]
      })?.recipients[0]?.round
    ).toBeUndefined()
  })
})

describe('the run after the fix turn ended', () => {
  it('asks EVERY reviewer of the round again, and retires every answer, approvals included', () => {
    const keys = ['op_second_1', 'op_second_2']
    const next = reaskSessionReview(
      chain(),
      'review',
      [fix()],
      [CHANGES, APPROVED],
      () => keys.shift()!,
      99
    )
    const step = next.steps[0]!
    expect(step.kind === 'handoff' && step.status).toBe('queued')
    // Both on their own thread, round 2, each under a fresh key.
    expect(step.kind === 'handoff' && step.handoff.recipients).toMatchObject([
      { delivery: 'pending', round: 2, operationId: 'op_second_1', threadId: 'hth_uma' },
      { delivery: 'pending', round: 2, operationId: 'op_second_2', threadId: 'hth_iris' }
    ])
    expect(next.currentIndex).toBe(0)
    const set = next.outcomeSet!
    expect(set.completedSteps).toEqual([])
    // Iris's OK was an OK of the old version: it is history like Uma's "needs changes".
    expect(set.outcomes[0]!.evidence).toEqual([])
    expect(set.outcomes[0]!.status).toBe('pending')
    expect(set.evidenceHistory?.map((entry) => entry.receipt)).toEqual([CHANGES, APPROVED])
    expect(set.heldContinuation?.fixes).toEqual([{ ...fix(), reaskedAt: 99 }])
    // Named on the hold, so the verifier cannot find the old OK on the thread and count it again.
    expect(set.heldContinuation?.superseded).toEqual([APPROVED])
    expect([...spentSessionReviewReceipts(set.heldContinuation)].sort()).toEqual(
      [APPROVED, CHANGES].sort()
    )
  })
})
