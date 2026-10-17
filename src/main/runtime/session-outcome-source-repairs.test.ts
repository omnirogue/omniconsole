import { expect, it } from 'vitest'
import type { NextStepActor } from '../../shared/next-step-draft'
import { nextOutcomeOutputInstruction } from '../../shared/next-outcome-compile'
import {
  consumeSessionReviewRepair,
  transitionSessionReviewRound
} from '../../shared/session-chain-review-transition'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import { materializeSessionOutcomeSourceRepairs } from './session-outcome-source-repairs'

const source: NextStepActor = {
  agent: 'codex',
  model: 'gpt-5.6-terra',
  effort: 'high',
  accountChoiceId: 'source-account'
}

function reviews(outcomeId = 'report', maxRounds = 3): SessionChainAgentStep[] {
  return Array.from({ length: maxRounds }, (_, index) => index + 1).flatMap((round) =>
    ['first', 'second'].map((reviewerId) => ({
      id: `${outcomeId}_${reviewerId}_${round}`,
      outcomeId,
      editorStepId: `${outcomeId}_review_editor`,
      agent: 'codex' as const,
      model: 'gpt-6-astra',
      prompt: 'Review the finished report.',
      presetId: 'review' as const,
      status: 'queued' as const,
      group: `${outcomeId}_review_round_${round}`,
      review: {
        groupId: `${outcomeId}_review`,
        reviewerId,
        round,
        maxRounds,
        candidateVersion: `${outcomeId}:candidate:${round}`,
        repairWithSource: true
      }
    }))
  )
}

function chainWith(steps: SessionChainStep[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'source-pane',
    sourceRowKey: 'source-row',
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
      attempts: [],
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [...new Set(steps.flatMap((step) => (step.outcomeId ? [step.outcomeId] : [])))].map(
        (outcomeId) => ({
          id: outcomeId,
          title: outcomeId,
          revision: 1,
          finish: 'my-review',
          status: 'pending',
          evidence: [],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'report', kind: 'report', target: 'report.md' }],
          stepIds: steps.filter((step) => step.outcomeId === outcomeId).map((step) => step.id)
        })
      )
    }
  }
}

function repairs(chain: SessionChain): SessionChainAgentStep[] {
  return chain.steps.filter(
    (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.reviewRepair)
  )
}

it('inserts one authenticated source repair between each review round and keeps the final handoff', () => {
  const handoff: SessionChainStep = {
    id: 'send-report',
    outcomeId: 'report',
    kind: 'handoff',
    status: 'queued',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Report',
      sessionLabel: 'Source report',
      recipients: [],
      deliverables: { kind: 'files', paths: ['report.md'] },
      includeSummary: true,
      note: '',
      savedAt: 1
    }
  }
  const original = chainWith([...reviews(), handoff])
  const result = materializeSessionOutcomeSourceRepairs(original, source)
  const inserted = repairs(result)
  expect(inserted).toHaveLength(2)
  expect(result.steps.map((step) => step.id)).toEqual([
    'report_first_1',
    'report_second_1',
    inserted[0]!.id,
    'report_first_2',
    'report_second_2',
    inserted[1]!.id,
    'report_first_3',
    'report_second_3',
    'send-report'
  ])
  expect(result.outcomeSet!.outcomes[0]!.stepIds).toEqual(result.steps.map((step) => step.id))
  expect(result.steps.at(-1)).toBe(handoff)
  expect(original.steps).toHaveLength(7)
  for (const [index, repair] of inserted.entries()) {
    expect(repair).toMatchObject({
      ...source,
      status: 'queued',
      outcomeId: 'report',
      editorStepId: 'report_review_editor',
      presetId: 'improve',
      reviewRepair: {
        groupId: 'report_review',
        afterRound: index + 1,
        candidateVersion: `report:candidate:${index + 1}`,
        withSource: true
      }
    })
    expect(repair.prompt).toContain('Repair only the documented blocking findings')
    expect(repair.prompt).toContain(
      nextOutcomeOutputInstruction('/workspace', original.id, repair.id)
    )
  }
  expect(new Set(inserted.map((step) => step.reviewRepair!.consumptionKey)).size).toBe(2)
  expect(materializeSessionOutcomeSourceRepairs(original, source)).toEqual(result)
})

it('uses the nearest preceding producer in the same outcome, excluding reviewers and repairs', () => {
  const producer: SessionChainAgentStep = {
    id: 'producer',
    outcomeId: 'report',
    agent: 'claude',
    model: 'claude-opus-4-1',
    effort: 'medium',
    accountChoiceId: null,
    prompt: 'Produce the report.',
    status: 'launched',
    launchedPaneKey: 'producer-pane'
  }
  const unrelated = {
    ...producer,
    id: 'other-producer',
    outcomeId: 'other',
    agent: 'gemini' as const
  }
  const original = chainWith([
    { ...producer, id: 'earlier-producer', model: 'earlier-model' },
    producer,
    unrelated,
    ...reviews()
  ])
  const result = materializeSessionOutcomeSourceRepairs(original, source)
  for (const repair of repairs(result)) {
    expect(repair).toMatchObject({
      agent: producer.agent,
      model: producer.model,
      effort: producer.effort,
      accountChoiceId: null
    })
    expect(repair.launchedPaneKey).toBeUndefined()
  }
  expect(result.outcomeSet!.outcomes.find((outcome) => outcome.id === 'other')).toBe(
    original.outcomeSet!.outcomes.find((outcome) => outcome.id === 'other')
  )
})

it('refuses to borrow a reviewer or a different outcome producer when the source is unverified', () => {
  const original = chainWith([
    { id: 'other', outcomeId: 'other', agent: 'codex', prompt: 'Other task', status: 'launched' },
    ...reviews()
  ])
  expect(() => materializeSessionOutcomeSourceRepairs(original)).toThrow(
    'The original source agent could not be verified'
  )
  expect(repairs(original)).toHaveLength(0)
})

it('keeps an explicitly configured repair owner unchanged even when source repair is requested', () => {
  const original = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
  for (const step of repairs(original)) {
    delete step.reviewRepair!.withSource
    step.model = 'explicit-model'
  }
  expect(materializeSessionOutcomeSourceRepairs(original)).toBe(original)
  expect(repairs(original).every((step) => step.model === 'explicit-model')).toBe(true)
})

it('preserves pinned repairs and consumed findings across completion and restart', () => {
  const original = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
  const first = repairs(original)[0]!
  const reviewer = original.steps[0] as SessionChainAgentStep
  const transition = transitionSessionReviewRound({
    assignment: reviewer.review!,
    reviewers: ['first', 'second'].map((reviewerId) => ({
      stepId: `report_${reviewerId}_1`,
      reviewerId,
      output: 'OMNI_REVIEW_RESULT: {"status":"findings","blockingFindings":["Missing conclusion"]}'
    })),
    hasAuthorizedRepair: true,
    reviewOnly: false,
    now: 2
  })
  expect(transition.next).toBe('launch-repair')
  const consumed = consumeSessionReviewRepair(transition.loop, first.reviewRepair!)
  expect(consumed.consumed).toBe(true)
  original.reviewLoop = consumed.loop
  first.status = 'launched'
  first.launchedPaneKey = 'actual-repair-pane'
  first.launchedAt = 3
  original.outcomeSet!.completedSteps = [first.id]
  original.outcomeSet!.attempts = [
    {
      id: 'repair-attempt',
      outcomeId: 'report',
      actionId: `step_${first.id}`,
      actionKey: 'action',
      outcomeRevision: 1,
      state: 'completed',
      startedAt: 3,
      updatedAt: 4,
      resultMessageId: 'receipt'
    }
  ]
  const restored: SessionChain = JSON.parse(JSON.stringify(original))
  const result = materializeSessionOutcomeSourceRepairs(restored, { agent: 'gemini', model: 'new' })
  expect(result).toBe(restored)
  expect(result).toEqual(original)
  expect(
    consumeSessionReviewRepair(result.reviewLoop!, repairs(result)[0]!.reviewRepair!).consumed
  ).toBe(false)
})

it('fills a missing source repair without replacing an existing pinned repair', () => {
  const original = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
  const [first, second] = repairs(original)
  original.steps = original.steps.filter((step) => step.id !== second!.id)
  original.outcomeSet!.outcomes[0]!.stepIds = original.outcomeSet!.outcomes[0]!.stepIds!.filter(
    (id) => id !== second!.id
  )
  first!.model = 'pinned-model'
  const result = materializeSessionOutcomeSourceRepairs(original, source)
  expect(repairs(result)[0]).toBe(first)
  expect(repairs(result)[1]).toEqual(second)
  expect(result.outcomeSet!.outcomes[0]!.stepIds).toEqual(result.steps.map((step) => step.id))
})

it('does not add repairs to one-round or legacy unflagged reviews', () => {
  const single = chainWith(reviews('single', 1))
  expect(materializeSessionOutcomeSourceRepairs(single)).toBe(single)
  const legacy = chainWith(reviews())
  for (const step of legacy.steps) {
    if (step.kind !== 'handoff') {
      delete step.review!.repairWithSource
    }
  }
  expect(materializeSessionOutcomeSourceRepairs(legacy)).toBe(legacy)
})

it('caps source repairs at four for five review rounds and rejects duplicate repair identities', () => {
  const original = materializeSessionOutcomeSourceRepairs(chainWith(reviews('report', 5)), source)
  expect(repairs(original)).toHaveLength(4)
  original.steps.push({ ...repairs(original)[0]!, id: 'duplicate-repair' })
  expect(() => materializeSessionOutcomeSourceRepairs(original, source)).toThrow(
    'more than one source repair step'
  )
})

it.each([
  'missing-final',
  'different-reviewer',
  'duplicate-reviewer',
  'missing-flag',
  'different-cap'
])(
  'refuses %s in the requested rounds even when all source repairs are already pinned',
  (change) => {
    const original = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
    const lastRound = original.steps.filter(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && step.review?.round === 3
    )
    if (change === 'missing-final') {
      original.steps = original.steps.filter(
        (step) => !lastRound.includes(step as SessionChainAgentStep)
      )
    } else if (change === 'different-reviewer') {
      lastRound[1]!.review!.reviewerId = 'replacement-reviewer'
    } else if (change === 'duplicate-reviewer') {
      lastRound[1]!.review!.reviewerId = lastRound[0]!.review!.reviewerId
    } else if (change === 'missing-flag') {
      delete lastRound[1]!.review!.repairWithSource
    } else {
      lastRound[1]!.review!.maxRounds = 4
    }
    expect(() => materializeSessionOutcomeSourceRepairs(original, source)).toThrow(
      change === 'missing-final'
        ? 'missing its reviewers'
        : change === 'different-reviewer' || change === 'duplicate-reviewer'
          ? 'same unique selected reviewers'
          : 'same selected round count and repair owner'
    )
    expect(repairs(original)).toHaveLength(2)
  }
)

it('materializes repairs only for the current plan version without adopting retired repairs', () => {
  const old = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
  const history = structuredClone(old.steps)
  const next = {
    ...old,
    planVersion: 2,
    steps: [
      ...old.steps,
      ...reviews().map((step) => ({ ...step, id: `v2_${step.id}`, planVersion: 2 }))
    ]
  }
  const compiled = materializeSessionOutcomeSourceRepairs(next, source)
  expect(compiled.steps.slice(0, history.length)).toEqual(history)
  expect(repairs(compiled).filter((step) => step.planVersion === 2)).toHaveLength(2)
  expect(new Set(compiled.steps.map((step) => step.id)).size).toBe(compiled.steps.length)
})
