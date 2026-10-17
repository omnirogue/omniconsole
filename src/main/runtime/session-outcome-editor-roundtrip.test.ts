import { describe, expect, it } from 'vitest'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { emptyNextStepDraft, type NextStepDraft } from '../../shared/next-step-draft'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
// eslint-disable-next-line typescript/prefer-ts-expect-error -- only node tsc rejects this test boundary
// @ts-ignore Integration coverage intentionally exercises renderer hydration and main reconciliation.
import { draftFromChain } from '../../renderer/src/components/next-step/next-step-outcome-hydration'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'

function compile(draft: NextStepDraft) {
  return compileNextStepChain({
    draft,
    chainId: 'chain_roundtrip',
    workspacePath: '/outside/execution',
    sessionLabel: 'Report',
    defaultNote: 'Report result.',
    now: 10,
    mintStepId: (position) => `random_${position}_${Math.random()}`,
    mintOperationId: () => `operation_${Math.random()}`
  }).steps
}

function reviewDraft(): NextStepDraft {
  const draft = emptyNextStepDraft()
  draft.outcomes = [
    {
      id: 'report',
      revision: 1,
      finish: { kind: 'complete' },
      instructions: 'Write the report to ./result.md.',
      steps: [
        {
          id: 'review-design',
          kind: 'review',
          reviewers: [
            { agent: 'codex', model: 'gpt-review' },
            { agent: 'grok', model: 'grok-review' }
          ],
          maxRounds: 2,
          instructions: 'Adversarially review the result.',
          adversarial: true
        },
        {
          id: 'repair-findings',
          kind: 'handoff',
          // PR #289 made the between-rounds repair explicit: a handoff after a review is only
          // the review's repair when it says so. Its own sibling fixture in
          // next-step-compile.test.ts gained the same flag; this one was missed.
          reviewRepair: true,
          actor: { agent: 'codex', model: 'gpt-repair' },
          presetId: 'implement',
          instructions: 'Repair only designated findings.'
        },
        {
          id: 'write-artifacts',
          kind: 'handoff',
          actor: { agent: 'codex' },
          presetId: 'implement',
          instructions: 'Write the artifacts.'
        },
        {
          id: 'verify-artifacts',
          kind: 'handoff',
          actor: { agent: 'grok' },
          presetId: 'verify',
          instructions: 'Verify the artifacts.'
        }
      ]
    }
  ]
  return draft
}

function persistedChain(draft: NextStepDraft): SessionChain {
  const steps = compile(draft)
  const outcomes = compileNextStepOutcomes(draft.outcomes!, {
    chainId: 'chain_roundtrip',
    workspacePath: '/outside/execution',
    sessionLabel: 'Report',
    fallbackActor: { agent: 'codex' },
    steps
  })
  const outcomeSet = reviseSessionOutcomeSet(
    undefined,
    {
      source: 'user',
      expectedRevision: 0,
      outcomes
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'one', state: 'owned' },
    1
  )
  const chain: SessionChain = {
    id: 'chain_roundtrip',
    workspacePath: '/outside/execution',
    worktreeId: 'folder:/work',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    hostId: 'local',
    auto: true,
    steps: steps.map((step, index) =>
      step.kind === 'handoff'
        ? step
        : {
            ...step,
            status: index < steps.length - 1 ? 'launched' : 'queued',
            launchedPaneKey: index < steps.length - 1 ? `pane_${index}` : undefined
          }
    ),
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet
  }
  chain.outcomeSet!.attempts = chain.steps
    .filter((step, index) => step.kind !== 'handoff' && index < chain.steps.length - 1)
    .map((step, index) => ({
      id: `attempt_${index}`,
      outcomeId: 'report',
      actionId: `step_${step.id}`,
      actionKey: `completed:${step.id}`,
      outcomeRevision: 1,
      state: 'completed',
      startedAt: 10,
      updatedAt: 11
    }))
  const repair = chain.steps.find((step) => step.kind !== 'handoff' && step.reviewRepair)
  chain.reviewLoop = {
    groups: [
      {
        id: 'review_report_review-design',
        maxRounds: 2,
        currentRound: 2,
        status: 'passed',
        rounds: [],
        consumedRepairKeys:
          repair && repair.kind !== 'handoff' ? [repair.reviewRepair!.consumptionKey] : []
      }
    ]
  }
  return chain
}

describe('outcome editor persisted-chain round trip', () => {
  it('preserves completed receipts and changes only an edited future obligation', () => {
    const old = normalizeSessionChain(structuredClone(persistedChain(reviewDraft())))!
    expect(old.steps.map((step) => (step.kind === 'handoff' ? null : step.editorStepId))).toEqual([
      'review-design',
      'review-design',
      'repair-findings',
      'review-design',
      'review-design',
      'write-artifacts',
      'verify-artifacts'
    ])
    const legacy: SessionChain = {
      ...old,
      steps: old.steps.map((step) => {
        if (step.kind === 'handoff') {
          return step
        }
        const { editorStepId: _editorStepId, ...legacyStep } = step
        return step.editorStepId === 'write-artifacts'
          ? { ...legacyStep, prompt: `${step.prompt}\n\n${step.prompt.split('\n\n').at(-1)}` }
          : legacyStep
      })
    }
    expect(compile(draftFromChain(legacy)).map((step) => step.id)).toEqual(
      old.steps.map((step) => step.id)
    )
    expect(
      compile(draftFromChain(legacy)).map((step) => (step.kind === 'handoff' ? '' : step.prompt))
    ).toEqual(old.steps.map((step) => (step.kind === 'handoff' ? '' : step.prompt)))

    const reopened = draftFromChain(old)
    const freshSteps = compile(reopened)
    const definitions = compileNextStepOutcomes(reopened.outcomes!, {
      chainId: old.id,
      workspacePath: old.workspacePath,
      sessionLabel: 'Report',
      fallbackActor: { agent: 'codex' },
      steps: freshSteps,
      committed: { definitions: old.outcomeSet!.outcomes, drafts: reopened.outcomes! }
    })
    const noOp = reconcileSessionOutcomeSteps({ ...old, steps: freshSteps }, old, {
      source: 'user',
      expectedRevision: old.outcomeSet!.revision,
      outcomes: definitions
    })
    expect(noOp.steps).toEqual(old.steps)
    expect(old.outcomeSet!.attempts).toHaveLength(old.steps.length - 1)
    expect(old.reviewLoop!.groups[0]!.consumedRepairKeys).toHaveLength(1)
    expect(reopened.outcomes![0]!.steps.map((step) => step.id)).toEqual([
      'review-design',
      'repair-findings',
      'write-artifacts',
      'verify-artifacts'
    ])
    expect(reopened.outcomes![0]!.steps[1]!.instructions).toBe('Repair only designated findings.')
    expect(
      freshSteps.every(
        (step) =>
          step.kind === 'handoff' ||
          step.review ||
          step.prompt.split('process exit alone').length === 2
      )
    ).toBe(true)

    reopened.outcomes![0]!.steps[3]!.instructions = 'Verify artifacts and signatures.'
    const edited = reconcileSessionOutcomeSteps({ ...old, steps: compile(reopened) }, old, {
      source: 'user',
      expectedRevision: old.outcomeSet!.revision,
      outcomes: definitions
    })
    expect(edited.steps.slice(0, -1)).toEqual(old.steps.slice(0, -1))
    expect(edited.steps.at(-1)).toMatchObject({ id: old.steps.at(-1)!.id, status: 'queued' })
    const editedLast = edited.steps.at(-1)!
    expect(editedLast.kind === 'handoff' ? '' : editedLast.prompt).toContain(
      'Verify artifacts and signatures.'
    )
  })
})
