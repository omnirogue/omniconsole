import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt, SessionOutcomeSet } from '../../shared/session-outcome-types'
import { recomputeSessionOutcomeStatuses } from './session-outcome-status-recompute'

/** No source is ready, so nothing here verifies: this is about what BLOCKS, and what no longer does. */
function scenario(input: {
  planVersion?: number
  attempt: Partial<SessionOutcomeAttempt>
  step?: Partial<SessionChainAgentStep>
}): { chain: SessionChain; set: SessionOutcomeSet } {
  const set = {
    revision: 1,
    outcomes: [
      {
        id: 'ship',
        title: 'Ship it',
        finish: 'complete',
        dependsOn: [],
        stepIds: ['seat'],
        conditions: [{ id: 'file', kind: 'file', target: '/workspace/out.txt' }],
        actions: [],
        revision: 1,
        status: 'pending',
        evidence: []
      }
    ],
    attempts: [
      {
        id: 'attempt_1',
        outcomeId: 'ship',
        actionId: 'step_seat',
        actionKey: 'seat',
        outcomeRevision: 1,
        state: 'blocked',
        error: 'The worker died.',
        startedAt: 1,
        updatedAt: 1,
        ...input.attempt
      }
    ],
    completedSteps: [],
    continuation: { sourceReady: false }
  } as unknown as SessionOutcomeSet
  const chain = {
    id: 'chain',
    workspacePath: '/workspace',
    ...(input.planVersion ? { planVersion: input.planVersion } : {}),
    steps: [
      {
        id: 'seat',
        agent: 'codex',
        prompt: 'work',
        status: 'queued',
        ...input.step
      } as SessionChainAgentStep
    ],
    outcomeSet: set
  } as unknown as SessionChain
  return { chain, set }
}

const statusOf = async (input: Parameters<typeof scenario>[0]) => {
  const { chain, set } = scenario(input)
  const recomputed = await recomputeSessionOutcomeStatuses({} as OrcaRuntimeService, chain, set)
  return recomputed.outcomes[0]!
}

describe('work a newer plan version replaced', () => {
  it('still blocks the outcome while it is the plan that is running', async () => {
    // A legacy record with no launch disposition cannot prove its worker stopped, and its failure
    // is long past the grace period: an honest failure, with the reason kept as a diagnostic.
    expect(await statusOf({ attempt: {} })).toMatchObject({
      status: 'blocked',
      blockedReason: 'The worker died.',
      block: { class: 'failed', code: 'unverifiable-worker' }
    })
  })

  it('never blocks once its attempt was superseded', async () => {
    expect(await statusOf({ attempt: { state: 'superseded' } })).toMatchObject({
      status: 'pending',
      blockedReason: undefined
    })
  })

  it('never blocks v2 with a failure that belongs to v1', async () => {
    expect(await statusOf({ planVersion: 2, attempt: { planVersion: 1 } })).toMatchObject({
      status: 'pending',
      blockedReason: undefined
    })
    // The same failure, stamped with the version now running, is a live blocker again.
    expect(await statusOf({ planVersion: 2, attempt: { planVersion: 2 } })).toMatchObject({
      status: 'blocked'
    })
  })

  it('never blocks v2 on a review group that belonged to a v1 seat', async () => {
    const { chain, set } = scenario({
      planVersion: 2,
      attempt: { state: 'completed', error: undefined },
      step: {
        planVersion: 1,
        review: {
          groupId: 'critique',
          reviewerId: 'seat',
          round: 1,
          maxRounds: 1,
          candidateVersion: 'v1'
        }
      } as Partial<SessionChainAgentStep>
    })
    const blocked = {
      ...chain,
      reviewLoop: { groups: [{ id: 'critique', status: 'blocked', rounds: [] }] }
    } as unknown as SessionChain
    const recomputed = await recomputeSessionOutcomeStatuses({} as OrcaRuntimeService, blocked, {
      ...set,
      outcomes: [{ ...set.outcomes[0]!, blockedReason: 'Review findings' }]
    })

    expect(recomputed.outcomes[0]).toMatchObject({ status: 'pending', blockedReason: undefined })
  })
})
