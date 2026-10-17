import { describe, expect, it } from 'vitest'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeAttempt,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import { restoreSessionOutcomeSourceRepairs } from './session-outcome-source-repair-revision'

function review(round: number, reviewerId: string, outcomeId = 'report'): SessionChainAgentStep {
  return {
    id: `${outcomeId}_${reviewerId}_${round}`,
    outcomeId,
    editorStepId: `${outcomeId}_editor`,
    agent: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    prompt: 'Review the finished report.',
    status: 'queued',
    group: `${outcomeId}_round_${round}`,
    review: {
      groupId: `${outcomeId}_review`,
      reviewerId,
      round,
      maxRounds: 3,
      repairWithSource: true,
      candidateVersion: 'compiled-candidate'
    }
  }
}

function repair(afterRound: number, outcomeId = 'report'): SessionChainAgentStep {
  return {
    id: `${outcomeId}_source_repair_${afterRound}`,
    outcomeId,
    editorStepId: `${outcomeId}_editor`,
    agent: 'claude',
    model: 'pinned-source-model',
    effort: 'medium',
    accountChoiceId: 'pinned-source-account',
    prompt: 'Repair the blocking findings within the original task.',
    presetId: 'improve',
    status: 'queued',
    reviewRepair: {
      groupId: `${outcomeId}_review`,
      afterRound,
      withSource: true,
      candidateVersion: `observed-candidate-${afterRound}`,
      consumptionKey: `${outcomeId}:consumed:${afterRound}`
    }
  }
}

function priorChain(): SessionChain {
  const steps = [1, 2, 3].flatMap((round) => [
    review(round, 'first'),
    review(round, 'second'),
    ...(round < 3 ? [repair(round)] : [])
  ])
  return {
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:/work',
    hostId: 'local',
    sourcePaneKey: 'source-pane',
    sourceRowKey: 'source-row',
    auto: true,
    steps,
    currentIndex: 2,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [
        {
          id: 'report',
          title: 'Review the report',
          finish: 'my-review',
          dependsOn: [],
          stepIds: steps.map((step) => step.id),
          // A 'my-review' finish has required a matching review condition since 4eb413e8c (#146);
          // the reviewed report file alone never satisfied validateSessionOutcomeDefinitions.
          conditions: [
            { id: 'report_result', kind: 'report', target: 'review.md' },
            { id: 'report_review', kind: 'review', target: 'review.md' }
          ],
          actions: [],
          revision: 1,
          status: 'running',
          evidence: []
        }
      ],
      attempts: [],
      removals: [],
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      updatedAt: 1
    }
  }
}

function reopen(previous: SessionChain): { chain: SessionChain; input: SessionOutcomeCommit } {
  const chain = structuredClone(previous)
  chain.steps = chain.steps.filter((step) => step.kind === 'handoff' || !step.reviewRepair)
  for (const step of chain.steps) {
    if (step.kind !== 'handoff' && step.review) {
      step.review.candidateVersion = 'fresh-renderer-candidate'
      step.status = 'queued'
      delete step.launchedPaneKey
      delete step.launchedAt
    }
  }
  return {
    chain,
    input: {
      expectedRevision: 1,
      source: 'user',
      outcomes: previous.outcomeSet!.outcomes.map((outcome) => ({
        ...sessionOutcomeDefinition(outcome),
        stepIds: outcome.stepIds!.filter((id) => chain.steps.some((step) => step.id === id))
      }))
    }
  }
}

describe('source repair revision restoration', () => {
  it.each<SessionOutcomeAttempt['state']>([
    'prepared',
    'launching',
    'running',
    'unverifiable',
    'completed'
  ])('reopens a %s repair through real step and outcome reconciliation', (state) => {
    const previous = priorChain()
    const pinned = previous.steps[2] as SessionChainAgentStep
    pinned.status = 'launched'
    pinned.launchedPaneKey = 'actual-repair-pane'
    pinned.launchedAt = 10
    pinned.hubThreadId = 'actual-thread'
    previous.outcomeSet!.attempts = [
      {
        id: 'actual-attempt',
        outcomeId: 'report',
        actionId: `step_${pinned.id}`,
        actionKey: 'actual-action-key',
        outcomeRevision: 1,
        state,
        startedAt: 10,
        updatedAt: 11,
        dispatchId: 'actual-dispatch',
        ...(state === 'completed' ? { resultMessageId: 'actual-result' } : {})
      }
    ]
    if (state === 'completed') {
      previous.outcomeSet!.completedSteps = [pinned.id]
    }
    const { chain, input } = reopen(previous)
    const before = structuredClone({ previous, chain, input })
    if (state !== 'completed') {
      expect(() => reconcileSessionOutcomeSteps(chain, previous, input)).toThrow(
        'may already be in progress'
      )
    } else {
      expect(reconcileSessionOutcomeSteps(chain, previous, input).steps).not.toEqual(previous.steps)
    }
    const restored = restoreSessionOutcomeSourceRepairs(chain, previous, input)
    expect(restored.chain.steps[2]).toBe(pinned)
    expect(restored.chain.steps[5]).toBe(previous.steps[5])
    expect(restored.chain.outcomeSet).toBe(chain.outcomeSet)
    expect(restored.input.outcomes[0]!.stepIds).toEqual(previous.outcomeSet!.outcomes[0]!.stepIds)
    const reconciled = reconcileSessionOutcomeSteps(restored.chain, previous, restored.input)
    expect(reconciled.steps).toEqual(previous.steps)
    const revised = reviseSessionOutcomeSet(
      previous.outcomeSet,
      reconciled.input,
      previous.outcomeSet!.continuation,
      12
    )
    expect(revised.outcomes[0]!.revision).toBe(1)
    expect(revised.attempts).toEqual(previous.outcomeSet!.attempts)
    expect(revised.completedSteps).toEqual(previous.outcomeSet!.completedSteps)
    expect({ previous, chain, input }).toEqual(before)
  })

  it.each(['missing', 'extra', 'identity', 'model', 'prompt', 'round-cap', 'repair-owner'])(
    'does not restore any round when the full reviewer group has a %s change',
    (change) => {
      const previous = priorChain()
      const { chain, input } = reopen(previous)
      const last = chain.steps.at(-1) as SessionChainAgentStep
      if (change === 'missing') {
        chain.steps.pop()
      }
      if (change === 'extra') {
        chain.steps.push({ ...last, id: 'additional-reviewer' })
      }
      if (change === 'identity') {
        last.id = 'changed-reviewer'
      }
      if (change === 'model') {
        last.model = 'different-model'
      }
      if (change === 'prompt') {
        last.prompt = 'Review a different task.'
      }
      if (change === 'round-cap') {
        last.review!.maxRounds = 4
      }
      if (change === 'repair-owner') {
        delete last.review!.repairWithSource
      }
      expect(restoreSessionOutcomeSourceRepairs(chain, previous, input)).toEqual({ chain, input })
    }
  )

  it('keeps existing repairs, unrelated steps, outcome definitions, and input ownership unchanged', () => {
    const previous = priorChain()
    const { chain, input } = reopen(previous)
    const existing: SessionChainAgentStep = {
      ...repair(1),
      id: 'explicit-repair',
      reviewRepair: { ...repair(1).reviewRepair!, withSource: undefined }
    }
    chain.steps.splice(2, 0, existing)
    input.outcomes[0]!.stepIds!.splice(2, 0, existing.id)
    const unrelated: SessionChainStep = {
      id: 'unrelated-step',
      outcomeId: 'unrelated',
      agent: 'gemini',
      prompt: 'Independent task',
      status: 'queued'
    }
    chain.steps.push(unrelated)
    const unrelatedOutcome = {
      ...input.outcomes[0]!,
      id: 'unrelated',
      stepIds: [unrelated.id]
    }
    input.outcomes.push(unrelatedOutcome)
    const restored = restoreSessionOutcomeSourceRepairs(chain, previous, input)
    expect(restored.chain.steps[2]).toBe(existing)
    expect(restored.chain.steps[5]).toBe(previous.steps[5])
    expect(restored.chain.steps.at(-1)).toBe(unrelated)
    expect(restored.input.outcomes[1]).toBe(unrelatedOutcome)
    expect(restored.input.outcomes[0]!.stepIds).toEqual(
      restored.chain.steps.filter((step) => step.outcomeId === 'report').map((step) => step.id)
    )
    expect(restoreSessionOutcomeSourceRepairs(restored.chain, previous, restored.input)).toEqual(
      restored
    )
  })

  it('does not restore an explicit repair, an unowned repair, or one from a different chain', () => {
    const previous = priorChain()
    const { chain, input } = reopen(previous)
    delete (previous.steps[2] as SessionChainAgentStep).reviewRepair!.withSource
    previous.steps[5]!.outcomeId = 'removed-outcome'
    expect(restoreSessionOutcomeSourceRepairs(chain, previous, input)).toEqual({ chain, input })
    expect(restoreSessionOutcomeSourceRepairs(chain, undefined, input)).toEqual({ chain, input })
    expect(restoreSessionOutcomeSourceRepairs(chain, { ...previous, id: 'other' }, input)).toEqual({
      chain,
      input
    })
  })
})
