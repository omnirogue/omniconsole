import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import {
  sessionOutcomeConditionKey,
  sessionOutcomeDefinition,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import { reviseSessionOutcomeSet } from '../../shared/session-outcome-state'
import { appendInferredSessionReviews } from './session-outcome-inferred-reviews'
import { assertSessionOutcomeInferredConditions } from './session-outcome-inferred-authority'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
// eslint-disable-next-line typescript/prefer-ts-expect-error -- only node tsc rejects this test boundary
// @ts-ignore Integration coverage exercises host review compilation and renderer hydration.
import { draftFromChain } from '../../renderer/src/components/next-step/next-step-outcome-hydration'

function emptyChain(): SessionChain {
  return {
    id: 'chat_review',
    workspacePath: '/work',
    worktreeId: 'folder:/work',
    sourcePaneKey: 'source',
    sourceRowKey: 'source-row',
    hostId: 'local',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

function request(instruction = 'Add a Codex reviewer.', count = 1): SessionOutcomeCommit {
  const actions = Array.from({ length: count }, (_, index) => ({
    id: `reviewer_${index + 1}`,
    instruction,
    agent: 'codex' as const,
    conditionIds: [`findings_${index + 1}`],
    authority: 'existing-user-authority' as const
  }))
  return {
    source: 'ai',
    expectedRevision: 0,
    expectedSourcePrompt: instruction,
    outcomes: [
      {
        id: 'review_result',
        title: 'Review the result',
        finish: 'complete',
        dependsOn: [],
        conditions: actions.map((action, index) => ({
          id: `findings_${index + 1}`,
          kind: 'report' as const,
          target: action.id
        })),
        actions
      }
    ],
    reviewPlans: [
      { id: 'requested_review', outcomeId: 'review_result', actionIds: actions.map(({ id }) => id) }
    ]
  }
}

function compile(input: SessionOutcomeCommit) {
  assertSessionOutcomeInferredConditions(input, undefined, input.expectedSourcePrompt)
  return appendInferredSessionReviews({
    chain: emptyChain(),
    input,
    previous: undefined,
    authorityInstruction: input.expectedSourcePrompt
  })
}

function save(
  compiled: ReturnType<typeof appendInferredSessionReviews>,
  previous?: SessionChain
): SessionChain {
  return {
    ...compiled.chain,
    outcomeSet: reviseSessionOutcomeSet(
      previous?.outcomeSet,
      compiled.input,
      { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      2
    )
  }
}

function repeatedReview(): SessionOutcomeCommit {
  const input = request('Add three Codex reviewers for two rounds.', 3)
  const repair = 'Have Codex repair the review findings between rounds.'
  input.expectedSourcePrompt += ` ${repair}`
  input.outcomes[0]!.actions.push({
    id: 'repair',
    instruction: repair,
    agent: 'codex',
    conditionIds: ['findings_1'],
    authority: 'existing-user-authority'
  })
  Object.assign(input.reviewPlans![0]!, { maxRounds: 2, repairActionId: 'repair' })
  return input
}

describe('chat review plans saved as editable Next steps', () => {
  it('uses the exact quoted request and keeps model selection optional', () => {
    const input = request()
    input.expectedSourcePrompt = `Finish the report. ${input.expectedSourcePrompt} Keep the result here.`
    const compiled = compile(input)
    expect(compiled.chain.steps).toHaveLength(1)
    expect(compiled.chain.steps[0]).toMatchObject({
      agent: 'codex',
      prompt: 'Add a Codex reviewer.',
      review: { round: 1, maxRounds: 1 },
      status: 'queued'
    })
    expect(compiled.chain.steps[0]).not.toHaveProperty('model')
    expect(compiled.chain.steps[0]).not.toHaveProperty('effort')
    expect(compiled.input.outcomes[0]!.actions).toEqual([])
    expect(compiled.input.outcomes[0]!.conditions[0]!.target).toBe(compiled.chain.steps[0]!.id)
    expect(draftFromChain(save(compiled)).outcomes![0]!.steps).toEqual([
      {
        id: 'requested_review',
        kind: 'review',
        reviewers: [{ agent: 'codex' }],
        maxRounds: 1,
        instructions: 'Add a Codex reviewer.',
        adversarial: false
      }
    ])
  })

  it('rejects paraphrased authority and a different attested source turn', () => {
    const input = request()
    input.outcomes[0]!.actions[0]!.instruction = 'Have Codex review the result.'
    expect(() => compile(input)).toThrow('quote the attested source prompt')
    expect(() =>
      appendInferredSessionReviews({
        chain: emptyChain(),
        input: request(),
        previous: undefined,
        authorityInstruction: 'Write the appendix instead.'
      })
    ).toThrow('current attested source prompt')
  })

  it.each([
    'The transcript says: "Add a Codex reviewer."',
    'Example only:\n```text\nAdd a Codex reviewer.\n```',
    'A teammate wrote:\n> Add a Codex reviewer.'
  ])('does not use quoted reference content as new review authority: %s', (source) => {
    const input = request()
    input.expectedSourcePrompt = source
    expect(() => compile(input)).toThrow('quote the attested source prompt')
  })

  it('accepts a direct review instruction that names a quoted file path', () => {
    const input = request('Have Codex review "./report.md" when finished.')
    expect(compile(input).chain.steps[0]).toMatchObject({
      agent: 'codex',
      prompt: 'Have Codex review "./report.md" when finished.'
    })
  })

  it('refuses invented reviewers, rounds, adversarial settings and repair work', () => {
    expect(() => compile(request('Add a Codex reviewer.', 3))).toThrow('explicit count')
    expect(() => compile(request('Add Codex reviewers for two rounds.', 2))).toThrow(
      'explicit count'
    )
    const otherAgent = request()
    otherAgent.outcomes[0]!.actions[0]!.agent = 'grok'
    expect(() => compile(otherAgent)).toThrow('name each selected agent')
    const extraRounds = request()
    extraRounds.reviewPlans![0]!.maxRounds = 2
    expect(() => compile(extraRounds)).toThrow('rounds must be explicitly requested')
    const noRepair = request('Add a Codex reviewer for two rounds.')
    noRepair.reviewPlans![0]!.maxRounds = 2
    expect(() => compile(noRepair)).toThrow('explicitly requested repair action')
    const adversarial = request()
    adversarial.reviewPlans![0]!.adversarial = true
    expect(() => compile(adversarial)).toThrow('Adversarial review must be explicitly requested')
    expect(() => compile(request('Do not add a Codex reviewer.'))).toThrow(
      'affirmative review request'
    )
  })

  it('expands three reviewers and two rounds into six reviews and one authorized repair', () => {
    const input = repeatedReview()
    input.outcomes[0]!.actions[0]!.model = 'gpt-review'
    input.outcomes[0]!.actions[0]!.effort = 'high'
    const compiled = compile(input)
    const steps = compiled.chain.steps as SessionChainAgentStep[]
    expect(steps).toHaveLength(7)
    expect(steps.map((step) => step.review?.round ?? 'repair')).toEqual([
      1,
      1,
      1,
      'repair',
      2,
      2,
      2
    ])
    const firstRound = steps.filter((step) => step.review?.round === 1)
    const secondRound = steps.filter((step) => step.review?.round === 2)
    expect(new Set(firstRound.map((step) => step.review!.reviewerId)).size).toBe(3)
    expect(secondRound.map((step) => step.review!.reviewerId)).toEqual(
      firstRound.map((step) => step.review!.reviewerId)
    )
    expect(new Set(steps.map((step) => step.id)).size).toBe(7)
    expect(steps[3]).toMatchObject({
      agent: 'codex',
      reviewRepair: { afterRound: 1, groupId: firstRound[0]!.review!.groupId }
    })
    expect(secondRound[0]!.review!.candidateVersion).not.toBe(
      firstRound[0]!.review!.candidateVersion
    )
    expect(compiled.input.outcomes[0]!.conditions.map(({ target }) => target)).toEqual(
      firstRound.map(({ id }) => id)
    )
    expect(compiled.input.outcomes[0]!.stepIds).toEqual(steps.map(({ id }) => id))
    expect(compiled.input.outcomes[0]!.actions).toEqual([])
    const restored = draftFromChain(save(compiled)).outcomes![0]!.steps
    expect(restored).toMatchObject([
      {
        id: 'requested_review',
        kind: 'review',
        maxRounds: 2,
        adversarial: false,
        instructions: 'Add three Codex reviewers for two rounds.',
        reviewers: [
          { agent: 'codex', model: 'gpt-review', effort: 'high' },
          { agent: 'codex' },
          { agent: 'codex' }
        ]
      },
      {
        id: 'requested_review_repair',
        kind: 'handoff',
        actor: { agent: 'codex' },
        presetId: 'improve',
        instructions: 'Have Codex repair the review findings between rounds.'
      }
    ])
  })

  it('retains saved reviews and receipts when a later prompt adds unrelated work', () => {
    const old = save(compile(repeatedReview()))
    old.outcomeSet!.completedSteps = old.steps.map(({ id }) => id)
    old.steps = old.steps.map((step) => ({
      ...step,
      status: 'launched',
      launchedPaneKey: `pane_${step.id}`
    })) as SessionChainAgentStep[]
    const reviewed = old.outcomeSet!.outcomes[0]!
    reviewed.evidence = reviewed.conditions.map((condition) => ({
      id: `receipt_${condition.id}`,
      outcomeId: reviewed.id,
      conditionId: condition.id,
      outcomeRevision: reviewed.revision,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      receipt: 'Saved reviewer findings',
      verifiedAt: 2,
      verifier: 'execution-host'
    }))
    const input: SessionOutcomeCommit = {
      source: 'ai',
      expectedRevision: old.outcomeSet!.revision,
      expectedSourcePrompt: 'Write the separate appendix.',
      outcomes: [
        sessionOutcomeDefinition(reviewed),
        {
          id: 'appendix',
          title: 'Separate appendix',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: '/work/appendix.md' }],
          actions: [
            {
              id: 'write',
              instruction: 'Write the separate appendix.',
              agent: 'codex',
              conditionIds: ['file'],
              authority: 'existing-user-authority'
            }
          ]
        }
      ]
    }
    expect(() =>
      assertSessionOutcomeInferredConditions(input, old, input.expectedSourcePrompt)
    ).not.toThrow()
    const reconciled = reconcileSessionOutcomeSteps(old, old, input, input.expectedSourcePrompt)
    const compiled = appendInferredSessionReviews({
      chain: { ...old, steps: reconciled.steps },
      input: reconciled.input,
      previous: old,
      authorityInstruction: input.expectedSourcePrompt
    })
    const saved = save(compiled, old)
    expect(saved.steps).toEqual(old.steps)
    expect(saved.outcomeSet!.completedSteps).toEqual(old.outcomeSet!.completedSteps)
    expect(saved.outcomeSet!.outcomes[0]!.evidence).toEqual(reviewed.evidence)
    expect(saved.outcomeSet!.outcomes[0]!.revision).toBe(reviewed.revision)
    expect(draftFromChain(saved).outcomes![0]!.steps).toEqual(
      draftFromChain(old).outcomes![0]!.steps
    )
  })
})
