import { describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAction,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'

const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
// #283 (7c2c01d48) refuses an oversized brief before a step launches; without this export that
// guard throws and the round refuses every reviewer instead of starting it.
vi.mock('./session-outcome-executor', () => ({
  launchSessionOutcomeAction: mocks.launch,
  sessionOutcomeExecutionBrief: () => 'brief'
}))
// The real version shells out to git; this suite is about launch concurrency only.
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import { advanceSessionOutcomeSteps } from './session-outcome-steps'

function reviewers(count: number): SessionChainAgentStep[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `r${index + 1}`
    return {
      id,
      outcomeId: 'reviewed',
      agent: 'codex',
      prompt: `review ${id}`,
      status: 'queued',
      group: 'review_round_1',
      review: {
        groupId: 'review',
        reviewerId: id,
        round: 1,
        maxRounds: 1,
        candidateVersion: 'unbound'
      }
    } as unknown as SessionChainAgentStep
  })
}

function scenario(count: number) {
  const steps = reviewers(count)
  const outcome = {
    id: 'reviewed',
    title: 'Reviewed deliverable',
    finish: 'complete',
    dependsOn: [],
    conditions: [],
    actions: [],
    stepIds: steps.map((step) => step.id),
    revision: 1,
    status: 'pending',
    evidence: []
  } as unknown as SessionOutcome
  let chain = {
    id: 'chain',
    workspacePath: '/nonexistent',
    steps,
    outcomeSet: {
      outcomes: [outcome],
      attempts: [],
      completedSteps: [],
      continuation: {},
      revision: 1
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
  const access = {
    runtime: {} as never,
    read: () => chain,
    save: (updated: SessionChain) => {
      chain = updated
    },
    persistAttempt: () => {}
  }
  return { access, outcome }
}

/** Holds the first reviewer's launch open until released. */
function heldFirstReviewer(): () => void {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.launch.mockReset()
  mocks.launch.mockImplementation(
    async (
      _runtime: unknown,
      _chain: SessionChain,
      _outcomeId: string,
      action: SessionOutcomeAction
    ) => {
      if (action.id === 'step_r1') {
        await gate
      }
      return { id: action.id, outcomeId: 'reviewed', actionId: action.id }
    }
  )
  return release
}

describe('a review round starts its reviewers together', () => {
  it('starts every reviewer before the first slow launch returns', async () => {
    const release = heldFirstReviewer()
    const { access, outcome } = scenario(3)

    const running = advanceSessionOutcomeSteps(access, outcome, 3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startedWhileFirstHeld = mocks.launch.mock.calls.length
    release()
    const result = await running

    // Reviewers judge the same candidate independently; a slow one must not gate its siblings.
    expect(startedWhileFirstHeld).toBe(3)
    expect(result).toEqual({ acted: true, launched: 3 })
  })

  it('never starts more reviewers than the budget authorizes', async () => {
    const release = heldFirstReviewer()
    const { access, outcome } = scenario(4)

    const running = advanceSessionOutcomeSteps(access, outcome, 2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startedWhileFirstHeld = mocks.launch.mock.calls.length
    release()
    await running

    expect(startedWhileFirstHeld).toBe(2)
    expect(mocks.launch.mock.calls).toHaveLength(2)
  })

  it('settles every reviewer it started before the round returns', async () => {
    mocks.launch.mockReset()
    let settled = 0
    mocks.launch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      settled += 1
    })
    const { access, outcome } = scenario(3)

    await advanceSessionOutcomeSteps(access, outcome, 3)

    // Otherwise the next tick sees no attempt for them and launches the round twice.
    expect(settled).toBe(3)
  })
})
