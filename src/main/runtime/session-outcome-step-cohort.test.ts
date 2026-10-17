import { describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAction,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'

const mocks = vi.hoisted(() => ({ launch: vi.fn(), brief: vi.fn(() => 'brief') }))
vi.mock('./session-outcome-executor', () => ({
  launchSessionOutcomeAction: mocks.launch,
  sessionOutcomeExecutionBrief: mocks.brief
}))
// The real version shells out to git; this suite is about which seats start, not the candidate.
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import { advanceSessionOutcomeSteps } from './session-outcome-steps'
import { launchStepCohort, sessionOutcomeStepCohort } from './session-outcome-step-cohort'
import { SessionOutcomeBriefTooLargeError } from './session-outcome-attempt-failure'

function step(id: string, extra: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep {
  return {
    id,
    outcomeId: 'ship',
    agent: 'codex',
    prompt: `do ${id}`,
    status: 'queued',
    ...extra
  } as SessionChainAgentStep
}

function reviewer(id: string, round = 1, group = 'critique_round_1'): SessionChainAgentStep {
  return step(id, {
    group,
    review: {
      groupId: 'critique',
      reviewerId: id,
      round,
      maxRounds: 1,
      candidateVersion: 'unbound'
    }
  } as Partial<SessionChainAgentStep>)
}

function scenario(steps: SessionChainAgentStep[], chainExtra: Partial<SessionChain> = {}) {
  const outcome = {
    id: 'ship',
    title: 'Ship it',
    finish: 'complete',
    dependsOn: [],
    conditions: [],
    actions: [],
    stepIds: steps.map((entry) => entry.id),
    revision: 1,
    status: 'pending',
    evidence: []
  } as unknown as SessionOutcome
  let chain = {
    id: 'chain',
    workspacePath: '/workspace',
    steps,
    ...chainExtra,
    outcomeSet: {
      outcomes: [outcome],
      attempts: [],
      completedSteps: [],
      continuation: {},
      revision: 1
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
  const attempts: SessionOutcomeAttempt[] = []
  const access = {
    runtime: {} as never,
    read: () => chain,
    save: (updated: SessionChain) => {
      chain = updated
    },
    persistAttempt: (attempt: SessionOutcomeAttempt) => {
      attempts.push(attempt)
      chain = {
        ...chain,
        outcomeSet: { ...chain.outcomeSet!, attempts: [...chain.outcomeSet!.attempts, attempt] }
      }
    }
  }
  return {
    access,
    outcome,
    attempts,
    current: () => chain,
    waitOf: (id: string) =>
      (chain.steps.find((entry) => entry.id === id) as SessionChainAgentStep | undefined)?.wait
  }
}

function launchedIds(): string[] {
  return mocks.launch.mock.calls.map((call) => (call[3] as SessionOutcomeAction).id)
}

/** Mirrors the real executor closely enough for this suite: it persists the attempt it started. */
function resetLaunch(): void {
  mocks.launch.mockReset()
  mocks.launch.mockImplementation(
    async (
      _runtime: unknown,
      _chain: SessionChain,
      _outcomeId: string,
      action: SessionOutcomeAction,
      persist: (attempt: SessionOutcomeAttempt) => void
    ) => {
      const attempt = {
        id: `attempt_${action.id}`,
        outcomeId: 'ship',
        actionId: action.id,
        actionKey: action.id,
        outcomeRevision: 1,
        state: 'running',
        startedAt: 1,
        updatedAt: 1
      } as SessionOutcomeAttempt
      persist(attempt)
      return attempt
    }
  )
  mocks.brief.mockReset()
  mocks.brief.mockImplementation(() => 'brief')
}

describe('which seats start together', () => {
  it('asks the review predicate BEFORE the group one', () => {
    // A compiled reviewer carries both: `next-outcome-compile` names its round as its group. When
    // the two disagree, the round wins — reviewers judge one pinned candidate independently.
    const steps = [
      reviewer('r1', 1, 'build'),
      reviewer('r2', 1, 'build'),
      step('x', { group: 'build' })
    ]
    const { access, outcome } = scenario(steps)
    expect(
      sessionOutcomeStepCohort(access.read(), outcome, steps[0]!).map((entry) => entry.id)
    ).toEqual(['r1', 'r2'])
    expect(
      sessionOutcomeStepCohort(access.read(), outcome, steps[2]!).map((entry) => entry.id)
    ).toEqual(['r1', 'r2', 'x'])
  })

  it('is the group for a grouped step and the step alone otherwise', () => {
    const steps = [step('a', { group: 'build' }), step('b', { group: 'build' }), step('c')]
    const { access, outcome } = scenario(steps)
    expect(
      sessionOutcomeStepCohort(access.read(), outcome, steps[0]!).map((entry) => entry.id)
    ).toEqual(['a', 'b'])
    expect(
      sessionOutcomeStepCohort(access.read(), outcome, steps[2]!).map((entry) => entry.id)
    ).toEqual(['c'])
  })
})

describe('launching a cohort', () => {
  it('starts the whole group and records why the rest are waiting', async () => {
    resetLaunch()
    const steps = [
      step('a', { group: 'build' }),
      step('b', { group: 'build' }),
      step('c', { group: 'build' })
    ]
    const harness = scenario(steps)

    const result = await launchStepCohort(
      harness.access,
      harness.access.read(),
      harness.outcome,
      steps[0]!,
      2
    )

    expect(result).toEqual({ launched: ['a', 'b'], waiting: ['c'] })
    expect(launchedIds()).toEqual(['step_a', 'step_b'])
    expect(harness.waitOf('c')).toMatchObject({ reason: 'capacity' })
    expect(harness.waitOf('a')).toBeUndefined()
  })

  it('never admits a seat whose enabling verdict has not landed, and says which', async () => {
    resetLaunch()
    const steps = [
      step('improve', { group: 'build', enabledBy: { verdict: 'judge', seatsOf: 'candidates' } }),
      step('note', { group: 'build' })
    ]
    const harness = scenario(steps)

    const held = await launchStepCohort(
      harness.access,
      harness.access.read(),
      harness.outcome,
      steps[0]!,
      5
    )

    expect(held).toEqual({ launched: ['note'], waiting: ['improve'] })
    expect(harness.waitOf('improve')).toMatchObject({ reason: 'dependency', ref: 'judge' })
  })

  it('admits the same seat once its verdict receipt exists', async () => {
    resetLaunch()
    const steps = [step('improve', { enabledBy: { verdict: 'judge', seatsOf: 'candidates' } })]
    const harness = scenario(steps, {
      verdicts: [
        { stepId: 'judge', attemptId: 'a1', verdict: {}, consumptionKey: 'k', consumedAt: 1 }
      ]
    })

    const started = await launchStepCohort(
      harness.access,
      harness.access.read(),
      harness.outcome,
      steps[0]!,
      5
    )

    expect(started.launched).toEqual(['improve'])
  })

  it('clears a seat wait when it launches', async () => {
    resetLaunch()
    const steps = [step('a', { group: 'build' }), step('b', { group: 'build' })]
    const harness = scenario(steps)

    await launchStepCohort(harness.access, harness.access.read(), harness.outcome, steps[0]!, 1)
    expect(harness.waitOf('b')).toMatchObject({ reason: 'capacity' })
    await launchStepCohort(harness.access, harness.access.read(), harness.outcome, steps[1]!, 1)

    expect(harness.waitOf('b')).toBeUndefined()
    expect(launchedIds()).toEqual(['step_a', 'step_b'])
  })

  it('records an unbriefable seat as a refused attempt instead of throwing', async () => {
    resetLaunch()
    mocks.brief.mockImplementation(() => {
      throw new SessionOutcomeBriefTooLargeError(
        'The full Next launch context is 120,000 characters; the worker limit is 100,000.'
      )
    })
    const steps = [step('a', { group: 'build' }), step('b', { group: 'build' })]
    const harness = scenario(steps)

    const result = await launchStepCohort(
      harness.access,
      harness.access.read(),
      harness.outcome,
      steps[0]!,
      2
    )

    expect(result.launched).toEqual([])
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(harness.attempts.map((attempt) => [attempt.actionId, attempt.state])).toEqual([
      ['step_a', 'blocked'],
      ['step_b', 'blocked']
    ])
    expect(harness.attempts[0]!.error).toContain('brief-too-large')
    expect(harness.attempts[0]!.launchDisposition).toBe('not-started')
    // The code, not the prose, is what the recovery ladder reads: only a shorter stage can pass,
    // so this refusal becomes a request and is never retried as it is.
    expect(harness.attempts[0]!.failure).toMatchObject({ code: 'brief-too-large' })
    expect(harness.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'recovering', code: 'brief-too-large' }
    })
    mocks.brief.mockImplementation(() => 'brief')
  })

  it('records any other staging failure as a launch that never started', async () => {
    resetLaunch()
    mocks.brief.mockImplementation(() => {
      throw new Error('The source packet could not be read.')
    })
    const steps = [step('a')]
    const harness = scenario(steps)

    await launchStepCohort(harness.access, harness.access.read(), harness.outcome, steps[0]!, 1)

    // Nothing was dispatched, so the ladder may retry it; it is not mislabelled as an oversized brief.
    expect(harness.attempts[0]).toMatchObject({
      state: 'blocked',
      launchDisposition: 'not-started',
      error: 'The source packet could not be read.',
      failure: { code: 'launch-not-started' }
    })
    mocks.brief.mockImplementation(() => 'brief')
  })
})

describe('the barrier', () => {
  it('returns the first incomplete step in plan order, never one behind it', async () => {
    resetLaunch()
    const steps = [step('first'), step('a', { group: 'build' }), step('b', { group: 'build' })]
    const harness = scenario(steps)

    // The group is second: while `first` is unfinished, nothing of the group may start.
    expect(await advanceSessionOutcomeSteps(harness.access, harness.outcome, 8)).toEqual({
      acted: true,
      launched: 1
    })
    expect(launchedIds()).toEqual(['step_first'])
  })

  it('holds the step after a group until every member of it is complete', async () => {
    resetLaunch()
    const steps = [step('a', { group: 'build' }), step('b', { group: 'build' }), step('integrate')]
    const harness = scenario(steps)

    await advanceSessionOutcomeSteps(harness.access, harness.outcome, 8)
    expect(launchedIds()).toEqual(['step_a', 'step_b'])

    // `a` finished, `b` has not: the integrator stays out of the plan's way.
    harness.access.save({
      ...harness.current(),
      outcomeSet: {
        ...harness.current().outcomeSet!,
        completedSteps: ['a'],
        attempts: harness
          .current()
          .outcomeSet!.attempts.map((attempt) =>
            attempt.actionId === 'step_a' ? { ...attempt, state: 'completed' } : attempt
          )
      }
    } as SessionChain)
    resetLaunch()
    await advanceSessionOutcomeSteps(harness.access, harness.outcome, 8)

    expect(launchedIds()).toEqual([])
  })
})
