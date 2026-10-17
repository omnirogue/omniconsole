import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from '../../../../shared/next-step-compile'
import { compileNextStepOutcomes } from '../../../../shared/next-outcome-definition-compile'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../shared/next-step-draft'
import { reviseSessionOutcomeSet } from '../../../../shared/session-outcome-state'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { draftFromChain } from './next-step-outcome-hydration'

function compile(draft: NextStepDraft) {
  return compileNextStepChain({
    draft,
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Report',
    defaultNote: 'Report',
    now: 1,
    mintStepId: (index) => `step_${index}`,
    mintOperationId: () => 'handoff'
  }).steps
}

function saved(reviewRepair: boolean) {
  const draft: NextStepDraft = {
    ...emptyNextStepDraft(),
    outcomes: [
      {
        id: 'outcome',
        revision: 1,
        finish: { kind: 'complete' },
        instructions: 'Write ./final.md.',
        steps: [
          {
            id: 'review',
            kind: 'review',
            reviewers: [{ agent: 'claude' }, { agent: 'codex' }],
            maxRounds: reviewRepair ? 3 : 1,
            adversarial: false,
            instructions: 'Review the report.'
          },
          {
            id: 'next-agent',
            kind: 'handoff',
            actor: { agent: 'codex' },
            presetId: 'improve',
            instructions: 'Improve the report.',
            ...(reviewRepair ? { reviewRepair: true } : {})
          }
        ]
      }
    ]
  }
  const steps = compile(draft)
  const outcomes = compileNextStepOutcomes(draft.outcomes!, {
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Report',
    fallbackActor: { agent: 'codex' },
    steps
  })
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:/work',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: reviseSessionOutcomeSet(
      undefined,
      { source: 'user', expectedRevision: 0, outcomes },
      { owner: 'execution-host', hostId: 'local', epoch: 'one', state: 'owned' },
      1
    )
  }
  return chain
}

describe('saved review and handoff semantics', () => {
  it('keeps source repairs inside the review settings when reopening materialized rounds', () => {
    const chain = saved(false)
    const draft = draftFromChain(chain)
    const review = draft.outcomes![0]!.steps[0]!
    if (review.kind !== 'review') {
      throw new Error('Missing review')
    }
    review.maxRounds = 3
    review.repairWithSource = true
    chain.steps = compile(draft)
    const first = chain.steps[0]!
    if (first.kind === 'handoff' || !first.review) {
      throw new Error('Missing compiled review')
    }
    chain.steps.splice(2, 0, {
      id: 'materialized-source-repair',
      editorStepId: 'review',
      outcomeId: 'outcome',
      agent: 'codex',
      model: 'source-model',
      prompt: 'Repair only the reported blockers.',
      status: 'queued',
      reviewRepair: {
        groupId: first.review.groupId,
        afterRound: 1,
        candidateVersion: first.review.candidateVersion,
        consumptionKey: 'source-repair-1',
        withSource: true
      }
    })
    const reopened = draftFromChain(chain)
    expect(reopened.outcomes![0]!.steps).toHaveLength(2)
    expect(reopened.outcomes![0]!.steps[0]).toMatchObject({
      kind: 'review',
      maxRounds: 3,
      repairWithSource: true
    })
    expect(reopened.outcomes![0]!.steps[1]).toMatchObject({ kind: 'handoff', id: 'next-agent' })
    expect(compile(reopened)).toEqual(
      chain.steps.filter((step) => step.id !== 'materialized-source-repair')
    )
  })

  it('reopens an ordinary agent after review and saves the same unconditional steps', () => {
    const chain = saved(false)
    const draft = draftFromChain(chain)
    expect(draft.outcomes![0]!.steps[1]).not.toHaveProperty('reviewRepair')
    expect(compile(draft)).toEqual(chain.steps)
  })

  it.each([false, true])('preserves persisted repairs with legacy editor IDs: %s', (legacy) => {
    const chain = saved(true)
    const originalSteps = structuredClone(chain.steps)
    if (legacy) {
      for (const step of chain.steps) {
        if (step.kind !== 'handoff') {
          delete step.editorStepId
        }
      }
    }
    const draft = draftFromChain(chain)
    expect(draft.outcomes![0]!.steps[1]).toMatchObject({
      id: 'next-agent',
      kind: 'handoff',
      reviewRepair: true,
      instructions: 'Improve the report.'
    })
    expect(compile(draft)).toEqual(originalSteps)
  })
})
