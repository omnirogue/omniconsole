import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real candidate version shells out to git; these rows are about a round's verdicts, so the
// seam is stubbed exactly as the verdict tests beside this file stub it.
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import { SESSION_RECOVERY_MAX_AUTO_RETRIES } from '../../shared/session-attempt-recovery'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { OrcaRuntimeService } from './omni-runtime'
import { finishReviewRound } from './session-outcome-review-round'
import type { OutcomeStepAccess } from './session-outcome-step-progress'
import {
  resumeSessionReviewVerdicts,
  sessionOutcomeVerdictReasksLeft
} from './session-outcome-verdict-reask'

const NOW = 9_000
const PASS = 'OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}'
const FINDINGS = 'OMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":["Fix the total"]}'
const bodies = new Map<string, string>()

const reviewer = (id: string, maxRounds = 1): SessionChainAgentStep => ({
  id,
  agent: 'codex',
  prompt: `Review as ${id}.`,
  status: 'queued',
  review: {
    groupId: 'review',
    reviewerId: id,
    round: 1,
    maxRounds,
    candidateVersion: 'candidate-1'
  }
})

function attempt(
  id: string,
  stepId: string,
  state: SessionOutcomeAttempt['state'] = 'completed'
): SessionOutcomeAttempt {
  return {
    id,
    outcomeId: 'outcome',
    actionId: `step_${stepId}`,
    actionKey: `key_${stepId}`,
    outcomeRevision: 1,
    state,
    taskId: `task_${id}`,
    startedAt: 1,
    updatedAt: 2
  }
}

function chainOf(steps: SessionChainAgentStep[], attempts: SessionOutcomeAttempt[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts,
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'outcome',
          title: 'Reviewed deliverable',
          revision: 1,
          finish: 'complete',
          status: 'pending',
          evidence: [],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: '/workspace/deliverable.txt' }],
          stepIds: steps.map((step) => step.id)
        }
      ]
    }
  }
}

function access(chain: SessionChain): OutcomeStepAccess & { chain(): SessionChain } {
  let current = chain
  return {
    runtime: {
      getOrchestrationDb: () => ({
        getTask: (id: string) => ({ result: JSON.stringify({ body: bodies.get(id) ?? '' }) })
      })
    } as unknown as OrcaRuntimeService,
    read: () => current,
    save: (updated) => {
      current = updated
    },
    persistAttempt: () => {},
    chain: () => current
  }
}

const outcomeOf = (chain: SessionChain): SessionOutcome => chain.outcomeSet!.outcomes[0]!
const stateOf = (chain: SessionChain, id: string): string | undefined =>
  chain.outcomeSet!.attempts.find((entry) => entry.id === id)?.state
const judge = (store: ReturnType<typeof access>, stepId: string): Promise<void> =>
  finishReviewRound(
    store,
    outcomeOf(store.chain()),
    store.chain().steps.find((step) => step.id === stepId) as SessionChainAgentStep,
    NOW
  )

beforeEach(() => bodies.clear())

describe('a reviewer that finishes without a verdict', () => {
  it('is asked again: only its attempt is given back, the round stays reviewing, nobody is asked', async () => {
    bodies.set('task_a1', PASS)
    bodies.set('task_b1', 'Looks fine to me, shipping it.')
    const store = access(
      chainOf([reviewer('a'), reviewer('b')], [attempt('a1', 'a'), attempt('b1', 'b')])
    )

    await judge(store, 'a')

    const after = store.chain()
    expect(stateOf(after, 'b1')).toBe('retryable')
    expect(stateOf(after, 'a1')).toBe('completed')
    expect(after.reviewLoop!.groups[0]).toMatchObject({ status: 'reviewing' })
    expect(after.reviewLoop!.groups[0]!.rounds[0]!.receipts.map((entry) => entry.stepId)).toEqual([
      'a'
    ])
    expect(outcomeOf(after).status).not.toBe('blocked')
    expect(after.outcomeSet!.completedSteps).toEqual([])
    expect(after.outcomeSet!.attention ?? []).toEqual([])
    expect(readSessionRun(after.outcomeSet!, { now: NOW })).toMatchObject({
      phase: 'active',
      attention: []
    })
    expect(sessionOutcomeVerdictReasksLeft(after, outcomeOf(after), 'b')).toBe(
      SESSION_RECOVERY_MAX_AUTO_RETRIES - 1
    )
  })

  it('never parks the seat that was just asked again as complete', async () => {
    bodies.set('task_a1', PASS)
    const store = access(
      chainOf([reviewer('a'), reviewer('b')], [attempt('a1', 'a'), attempt('b1', 'b', 'retryable')])
    )
    // The step runner judges from the seat whose attempt it saw complete; here that attempt was
    // given back in the same pass (the strict verdict consumer asked it again first).
    await judge(store, 'b')
    expect(store.chain().outcomeSet!.completedSteps).toEqual([])
    expect(store.chain().reviewLoop).toBeUndefined()
  })

  it('reopens a silent seat its round had parked as complete, so it can launch again', async () => {
    // `a` finished first and was parked while `b` still ran; `a` is the one that said nothing.
    bodies.set('task_a1', 'Looks fine to me, shipping it.')
    bodies.set('task_b1', PASS)
    const parked = chainOf([reviewer('a'), reviewer('b')], [attempt('a1', 'a'), attempt('b1', 'b')])
    const store = access({
      ...parked,
      currentIndex: 1,
      outcomeSet: { ...parked.outcomeSet!, completedSteps: ['a'] }
    })

    await judge(store, 'b')

    const after = store.chain()
    expect(stateOf(after, 'a1')).toBe('retryable')
    expect(stateOf(after, 'b1')).toBe('completed')
    // Left in `completedSteps` the seat would never start again and its round never be judged.
    expect(after.outcomeSet!.completedSteps).toEqual([])
    expect(after.currentIndex).toBe(0)
    expect(after.reviewLoop!.groups[0]).toMatchObject({ status: 'reviewing' })
  })

  it('completes on the valid verdict the re-ask returns, with no request and no block', async () => {
    bodies.set('task_a1', PASS)
    bodies.set('task_b2', PASS)
    const store = access(
      chainOf(
        [reviewer('a'), reviewer('b')],
        [attempt('a1', 'a'), attempt('b1', 'b', 'retryable'), attempt('b2', 'b')]
      )
    )

    await judge(store, 'b')

    const after = store.chain()
    expect(after.reviewLoop!.groups[0]).toMatchObject({ status: 'passed' })
    expect(after.outcomeSet!.completedSteps).toEqual(['a', 'b'])
    expect(outcomeOf(after).status).not.toBe('blocked')
    expect(after.outcomeSet!.attention ?? []).toEqual([])
  })

  it('fails as reviewer-no-verdict once the bound is spent, and gives no more attempts back', async () => {
    bodies.set('task_a1', PASS)
    const spent = [
      attempt('a1', 'a'),
      attempt('b1', 'b', 'retryable'),
      attempt('b2', 'b', 'retryable'),
      attempt('b3', 'b')
    ]
    const store = access(chainOf([reviewer('a'), reviewer('b')], spent))

    await judge(store, 'b')

    const after = store.chain()
    expect(stateOf(after, 'b3')).toBe('completed')
    expect(after.reviewLoop!.groups[0]).toMatchObject({ status: 'blocked' })
    expect(outcomeOf(after)).toMatchObject({
      status: 'blocked',
      blockedReason: 'A selected reviewer did not return a valid verdict.',
      block: { class: 'failed', code: 'reviewer-no-verdict', since: NOW }
    })
    expect(after.outcomeSet!.attention ?? []).toEqual([])
    expect(readSessionRun(after.outcomeSet!, { now: NOW })).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: [],
      failure: { code: 'reviewer-no-verdict' }
    })
    // Judged again by a later tick: still failed, still no relaunch.
    await judge(store, 'b')
    expect(store.chain().outcomeSet!.attempts.map((entry) => entry.state)).toEqual(
      spent.map((entry) => entry.state)
    )
  })

  it('is a different thing from a valid rejection: findings at the cap ask the owner to decide', async () => {
    bodies.set('task_a1', PASS)
    bodies.set('task_b1', FINDINGS)
    const store = access(
      chainOf([reviewer('a'), reviewer('b')], [attempt('a1', 'a'), attempt('b1', 'b')])
    )
    // A repair seat exists for the group, so findings are not a finished report; the single
    // authorized round is already used, so nothing is left to launch.
    store.save({
      ...store.chain(),
      steps: [
        ...store.chain().steps,
        {
          id: 'repair',
          agent: 'codex',
          prompt: 'Repair',
          status: 'queued',
          reviewRepair: {
            groupId: 'review',
            afterRound: 2,
            candidateVersion: 'candidate-1',
            consumptionKey: 'repair-once'
          }
        }
      ]
    })

    await judge(store, 'a')

    const after = store.chain()
    expect(stateOf(after, 'b1')).toBe('completed')
    expect(outcomeOf(after).block).toMatchObject({ class: 'attention', code: 'review-findings' })
    const run = readSessionRun(after.outcomeSet!, { now: NOW })
    expect(run.phase).toBe('needs-you')
    expect(run.attention).toMatchObject([
      { kind: 'decision', action: { kind: 'open-up-next' }, source: { type: 'review-findings' } }
    ])
    expect(outcomeOf(after).block!.attentionIds).toEqual([run.attention[0]!.id])
  })
})

describe("a person's Resume on a round that stopped for a missing verdict", () => {
  it('gives the silent seat one more attempt and leaves a findings round alone', async () => {
    bodies.set('task_a1', PASS)
    const store = access(
      chainOf(
        [reviewer('a'), reviewer('b')],
        [
          attempt('a1', 'a'),
          attempt('b1', 'b', 'retryable'),
          attempt('b2', 'b', 'retryable'),
          attempt('b3', 'b')
        ]
      )
    )
    await judge(store, 'b')
    const resumed = resumeSessionReviewVerdicts(store.chain())
    expect(stateOf(resumed, 'b3')).toBe('retryable')
    expect(stateOf(resumed, 'a1')).toBe('completed')
    expect(resumed.reviewLoop!.groups[0]).toMatchObject({ status: 'reviewing' })
    expect(resumed.outcomeSet!.outcomes[0]).toMatchObject({ status: 'pending' })
    expect(resumed.outcomeSet!.outcomes[0]!.block).toBeUndefined()
    // Nothing to release: the same chain back, so a caller that saves on change saves nothing.
    expect(resumeSessionReviewVerdicts(resumed)).toBe(resumed)
  })

  it('reopens a silent seat that was parked, so the resumed round can actually run it', async () => {
    bodies.set('task_b1', PASS)
    const parked = chainOf(
      [reviewer('a'), reviewer('b')],
      [
        attempt('a1', 'a', 'retryable'),
        attempt('a2', 'a', 'retryable'),
        attempt('a3', 'a'),
        attempt('b1', 'b')
      ]
    )
    const store = access({
      ...parked,
      currentIndex: 1,
      outcomeSet: { ...parked.outcomeSet!, completedSteps: ['a'] }
    })
    await judge(store, 'b')
    expect(store.chain().reviewLoop!.groups[0]).toMatchObject({ status: 'blocked' })

    const resumed = resumeSessionReviewVerdicts(store.chain())
    expect(stateOf(resumed, 'a3')).toBe('retryable')
    expect(stateOf(resumed, 'b1')).toBe('completed')
    expect(resumed.outcomeSet!.completedSteps).toEqual([])
    expect(resumed.currentIndex).toBe(0)
    expect(resumed.reviewLoop!.groups[0]).toMatchObject({ status: 'reviewing' })
  })
})
