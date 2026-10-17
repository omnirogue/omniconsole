/**
 * Which run owns the work held behind a person review, and which reviews hold a run. Only a
 * Review (feedback) can hold anything: a Hand off is terminal, so even a stray draft naming one
 * holds nothing and its run seals on the verified delivery as before (owner's ruling E). A Review
 * holds its run until every named person approved, whether or not work waits behind it.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import type { SessionOutcomeEvidence } from '../../shared/session-outcome-types'
import { auditSessionRuns } from '../../shared/session-run-audit'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import { runSet } from '../../shared/session-run-lifecycle.test-fixture'
import {
  clearUpNextContinuationRefusal,
  recordUpNextContinuationRefusal,
  upNextGateOwner,
  upNextHeldContinuation,
  upNextUnfinishedBesideReview
} from './up-next-held-gates'

const ROW = 'row'

const person = (
  id: string,
  disposition: 'feedback' | 'ownership-transfer',
  people: readonly string[] = ['emp_uma']
) =>
  ({
    id,
    kind: 'handoff',
    status: 'delivered',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Intro',
      sessionLabel: 'Intro',
      recipients: people.map((employeeId) => ({
        employeeId,
        name: employeeId,
        operationId: `op_${id}_${employeeId}`,
        delivery: 'sent' as const
      })),
      action: disposition === 'feedback' ? 'review' : 'edit',
      disposition,
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true,
      note: 'Intro',
      savedAt: 1
    }
  }) satisfies SessionChainHandoffStep

const run = (id: string, steps: SessionChain['steps'], extra: Partial<SessionChain> = {}) =>
  ({
    id,
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: ROW,
    auto: true,
    steps,
    currentIndex: steps.length,
    state: 'waiting',
    outcomeSet: runSet(),
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }) as SessionChain

const heldBehind = (stepId: string): UpNextDraftEntry => ({
  id: `draft:${stepId}`,
  input: { kind: 'agent', template: 'improve', instruction: 'Improve it.' } as never,
  held: { reviewStepId: stepId, committedAt: 5 },
  createdAt: 4
})

const drafts = (...entries: UpNextDraftEntry[]) => ({
  readUpNextDrafts: (rowKey: string) =>
    rowKey === ROW ? { subject: {} as never, entries, updatedAt: 5 } : null
})

describe('the run a held continuation belongs to', () => {
  it('is the newest run of the conversation that asked this review', () => {
    const older = run('source_a', [person('review', 'feedback')], { createdAt: 1 })
    const newer = run('source_a_1', [person('review', 'feedback')], { createdAt: 9 })
    const other = run('source_b', [person('other', 'feedback')], { createdAt: 20 })
    expect(upNextGateOwner([older, newer, other], ROW, 'review')?.id).toBe('source_a_1')
    expect(upNextGateOwner([older, { ...newer, state: 'cancelled' }], ROW, 'review')?.id).toBe(
      'source_a'
    )
  })

  it('is never a Hand off: a stray draft naming one holds nothing', () => {
    const handoff = run('source_a', [person('handoff', 'ownership-transfer')])
    expect(upNextGateOwner([handoff], ROW, 'handoff')).toBeNull()
    expect(upNextHeldContinuation(drafts(heldBehind('handoff')), handoff, [handoff])).toBeNull()
  })

  it('names the review gates of THIS run, and the refusal the host last met starting them', () => {
    const review = run('source_a', [person('review', 'feedback')])
    const runtime = drafts(heldBehind('review'), heldBehind('review'), heldBehind('elsewhere'))
    expect(upNextHeldContinuation(runtime, review, [review])).toEqual({
      reviewStepIds: ['review']
    })
    recordUpNextContinuationRefusal(
      runtime,
      'source_a',
      'review',
      '  upNext.refusal.needsAgent ',
      1_000
    )
    expect(upNextHeldContinuation(runtime, review, [review])).toEqual({
      reviewStepIds: ['review'],
      refused: 'upNext.refusal.needsAgent',
      refusedSince: 1_000
    })
    clearUpNextContinuationRefusal(runtime, 'source_a', 'review')
    expect(upNextHeldContinuation(runtime, review, [review])?.refused).toBeUndefined()
  })

  it('keeps when a refusal first appeared while it continues, and starts over once it clears', () => {
    const review = run('source_a', [person('review', 'feedback')])
    const runtime = drafts(heldBehind('review'))
    recordUpNextContinuationRefusal(runtime, 'source_a', 'review', 'Pane not found.', 1_000)
    // Refused again, in other words: the same refusal still stands, so its clock does not restart.
    recordUpNextContinuationRefusal(runtime, 'source_a', 'review', 'Not readable.', 9_000)
    expect(upNextHeldContinuation(runtime, review, [review])).toMatchObject({
      refused: 'Not readable.',
      refusedSince: 1_000
    })
    clearUpNextContinuationRefusal(runtime, 'source_a', 'review')
    recordUpNextContinuationRefusal(runtime, 'source_a', 'review', 'Pane not found.', 20_000)
    expect(upNextHeldContinuation(runtime, review, [review])?.refusedSince).toBe(20_000)
  })

  it('holds nothing on a host with no draft store, or with no held draft', () => {
    const review = run('source_a', [person('review', 'feedback')])
    expect(upNextHeldContinuation({} as never, review, [review])).toBeNull()
    expect(upNextHeldContinuation(drafts(), review, [review])).toBeNull()
  })
})

describe('work queued beside the review', () => {
  it('runs first: a stage of the same plan version that has not finished holds the review back', () => {
    const stage = {
      id: 's1',
      agent: 'claude',
      prompt: 'Draft it.',
      status: 'queued'
    } as SessionChain['steps'][number]
    const queued = run('source_a', [stage, person('review', 'feedback')])
    expect(upNextUnfinishedBesideReview(queued)).toBe(true)
    const done: SessionChain = {
      ...queued,
      outcomeSet: { ...queued.outcomeSet!, completedSteps: ['s1'] }
    }
    expect(upNextUnfinishedBesideReview(done)).toBe(false)
  })
})

const answer = (
  employeeId: string,
  decision: 'approve' | 'request_changes'
): SessionOutcomeEvidence => ({
  id: `ev_${employeeId}`,
  outcomeId: 'o1',
  conditionId: `review_${employeeId}`,
  outcomeRevision: 1,
  conditionKey: 'k',
  kind: 'review',
  target: employeeId,
  receipt: `handoff-review:hth_${employeeId}:hrv_${employeeId}:${decision}`,
  verifiedAt: 30,
  verifier: 'execution-host'
})

/** A Review of `people` as the run's last block, nothing queued behind it, and their answers. */
const lastReview = (
  people: readonly string[],
  evidence: SessionOutcomeEvidence[] = [],
  disposition: 'feedback' | 'ownership-transfer' = 'feedback'
): SessionChain =>
  run('source_a', [person('review', disposition, people)], {
    outcomeSet: {
      ...runSet(),
      completedSteps: ['review'],
      outcomes: [
        {
          id: 'o1',
          title: 'Intro reviewed',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['review'],
          conditions: people.map((employeeId) => ({
            id: `review_${employeeId}`,
            kind: 'review' as const,
            target: employeeId,
            recipientId: employeeId
          })),
          actions: [],
          revision: 1,
          status: evidence.length === people.length ? 'satisfied' : 'pending',
          evidence
        }
      ]
    }
  })

const gates = (chain: SessionChain) => upNextHeldContinuation(drafts(), chain, [chain])

describe('a ticked Review with nothing held behind it', () => {
  it('holds its run until every named person approved the current work', () => {
    const both = ['emp_uma', 'emp_iris']
    expect(gates(lastReview(both))).toEqual({ reviewStepIds: ['review'] })
    // 1 of 2 said OK: still held.
    expect(gates(lastReview(both, [answer('emp_uma', 'approve')]))).toEqual({
      reviewStepIds: ['review']
    })
    // Everyone replied, but one asked for changes: still held.
    const mixed = [answer('emp_uma', 'approve'), answer('emp_iris', 'request_changes')]
    expect(gates(lastReview(both, mixed))).toEqual({ reviewStepIds: ['review'] })
    const approved = [answer('emp_uma', 'approve'), answer('emp_iris', 'approve')]
    expect(gates(lastReview(both, approved))).toBeNull()
  })

  it('holds the run a "needs changes" reply would have finished', () => {
    const changes = lastReview(['emp_uma'], [answer('emp_uma', 'request_changes')])
    expect(gates(changes)).toEqual({ reviewStepIds: ['review'] })
    // With work queued behind the same review, it is still one gate.
    expect(upNextHeldContinuation(drafts(heldBehind('review')), changes, [changes])).toEqual({
      reviewStepIds: ['review']
    })
  })

  it('holds nothing on a Hand off, a cancelled run or a review of a plan the run no longer pursues', () => {
    const changes = [answer('emp_uma', 'request_changes')]
    expect(gates(lastReview(['emp_uma'], changes, 'ownership-transfer'))).toBeNull()
    expect(gates({ ...lastReview(['emp_uma'], changes), state: 'cancelled' })).toBeNull()
    expect(gates({ ...lastReview(['emp_uma'], changes), planVersion: 2 })).toBeNull()
  })

  it('holds no card-bound or planning-source run, whose tick never hands the notes to the agent', () => {
    const changes = lastReview(['emp_uma'], [answer('emp_uma', 'request_changes')])
    const set = changes.outcomeSet!
    const workflow: SessionChain = { ...changes, outcomeSet: { ...set, workflow: {} as never } }
    const planning: SessionChain = {
      ...changes,
      outcomeSet: {
        ...set,
        continuation: {
          ...set.continuation,
          planningSource: {
            runId: 'run_1',
            projectionTaskId: 'task_1',
            coordinatorHandle: 'coordinator_1',
            processIncarnation: 'process:1'
          }
        }
      }
    }
    // Held here, "needs changes" would strand the run until it failed: it seals on the reply.
    expect(gates(workflow)).toBeNull()
    expect(gates(planning)).toBeNull()
    // Work queued behind the review still holds either route, as it always did.
    expect(upNextHeldContinuation(drafts(heldBehind('review')), workflow, [workflow])).toEqual({
      reviewStepIds: ['review']
    })
    expect(upNextHeldContinuation(drafts(heldBehind('review')), planning, [planning])).toEqual({
      reviewStepIds: ['review']
    })
  })

  it('leaves a run an older build sealed on "needs changes" as it is, and the audit quiet', () => {
    const answered = lastReview(['emp_uma'], [answer('emp_uma', 'request_changes')])
    const sealed: SessionChain = {
      ...answered,
      state: 'done',
      outcomeSet: sealSessionRunCompletion(answered.outcomeSet!, { now: 50, operationId: 'op' })
    }
    expect(gates(sealed)).toBeNull()
    expect(auditSessionRuns([sealed], 60, (chain) => gates(chain))).toEqual([])
  })
})

describe('a second Review of the same person, released after the first', () => {
  /** Uma approved `review`, and `review_2` asks him again later; his one condition holds `evidence`. */
  const askedAgain = (evidence: SessionOutcomeEvidence[]): SessionChain => {
    const again = person('review_2', 'feedback')
    const chain = lastReview(['emp_uma'], evidence)
    const outcome = chain.outcomeSet!.outcomes[0]!
    return {
      ...chain,
      steps: [...chain.steps, { ...again, handoff: { ...again.handoff, savedAt: 50 } }],
      outcomeSet: {
        ...chain.outcomeSet!,
        completedSteps: ['review', 'review_2'],
        outcomes: [{ ...outcome, stepIds: ['review', 'review_2'] }]
      }
    }
  }
  const later = (decision: 'approve' | 'request_changes'): SessionOutcomeEvidence => ({
    ...answer('emp_uma', decision),
    verifiedAt: 60
  })

  it('is the one gate: the first ask, whose answer is history, holds nothing', () => {
    // His answer to the first ask was retired when the second one was made: only that one is out.
    expect(gates(askedAgain([]))).toEqual({ reviewStepIds: ['review_2'] })
    // "Needs changes" on the second ask is the second ask's, never the first one's.
    expect(gates(askedAgain([later('request_changes')]))).toEqual({
      reviewStepIds: ['review_2']
    })
    expect(gates(askedAgain([later('approve')]))).toBeNull()
  })
})
