import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import {
  emptyNextStepDraft,
  nextStepOutcomeProblems,
  type NextStepOutcomeStep
} from './next-step-draft'
import { sessionChainPredecessors } from './session-chain-types'
import { composeReviewStepInstructions, REVIEW_RUBRIC_PRESETS } from './review-rubrics'

const review: NextStepOutcomeStep = {
  id: 'review',
  kind: 'review',
  reviewers: [{ agent: 'claude' }, { agent: 'codex' }],
  maxRounds: 1,
  adversarial: false,
  instructions: 'Review the report.'
}
const handoff: NextStepOutcomeStep = {
  id: 'next-agent',
  kind: 'handoff',
  actor: { agent: 'codex' },
  presetId: 'synthesize',
  instructions: 'Combine the review findings into the final report.'
}

function outcome(steps: NextStepOutcomeStep[]) {
  return { id: 'outcome', finish: { kind: 'complete' as const }, instructions: '', steps }
}

function compile(steps: NextStepOutcomeStep[]) {
  return compileNextStepChain({
    draft: { ...emptyNextStepDraft(), outcomes: [outcome(steps)] },
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Report',
    defaultNote: 'Report',
    now: 1,
    mintStepId: (index) => `step_${index}`,
    mintOperationId: () => 'handoff'
  })
}

describe('review rubrics', () => {
  it("asks each reviewer seat about its own rubric, or the step's", () => {
    const [general, reliability, design] = REVIEW_RUBRIC_PRESETS
    const instructions = composeReviewStepInstructions({
      shared: general!,
      perReviewer: [design!, undefined, reliability!],
      focus: 'The settings page.'
    })
    const result = compile([
      {
        ...review,
        reviewers: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'grok' }],
        instructions
      }
    ])
    expect(result.problems).toEqual([])
    const prompts = result.steps.map((step) => (step.kind === 'handoff' ? '' : step.prompt))
    expect(prompts[0]).toContain('Rubric: Design quality')
    expect(prompts[1]).toContain('Rubric: General')
    expect(prompts[2]).toContain('Rubric: Reliability')
    for (const prompt of prompts) {
      expect(prompt).toContain('The settings page.')
      expect(prompt).not.toContain('Rubric (reviewer')
    }
  })
})

describe('review followed by an ordinary agent', () => {
  it('creates independent sessions for reviewers who share the same provider and model', () => {
    const actor = { agent: 'codex' as const, model: 'gpt-6-astra' }
    const result = compile([{ ...review, reviewers: [actor, actor] }, handoff])
    expect(result.problems).toEqual([])
    expect(result.steps.slice(0, 2)).toMatchObject([
      { ...actor, review: { reviewerId: 'review:codex:1' } },
      { ...actor, review: { reviewerId: 'review:codex:2' } }
    ])
    expect(new Set(result.steps.map((step) => step.id)).size).toBe(3)
  })

  it('keeps the next agent after a report-only review', () => {
    const result = compile([review, handoff])
    expect(result.problems).toEqual([])
    expect(result.steps).toHaveLength(3)
    expect(result.steps[2]).toMatchObject({
      id: 'outcome_next-agent',
      agent: 'codex',
      presetId: 'synthesize',
      status: 'queued'
    })
    expect(result.steps[2]).not.toHaveProperty('reviewRepair')
    expect(sessionChainPredecessors(result, 2)).toEqual(result.steps.slice(0, 2))
  })

  it('keeps an ordinary agent after an explicitly selected repair loop', () => {
    const result = compile([
      { ...review, maxRounds: 3 },
      { ...handoff, id: 'repair', reviewRepair: true, presetId: 'improve' },
      handoff
    ])
    expect(result.problems).toEqual([])
    expect(result.steps).toHaveLength(9)
    expect(result.steps.at(-1)).toMatchObject({ id: 'outcome_next-agent', presetId: 'synthesize' })
    expect(result.steps.at(-1)).not.toHaveProperty('reviewRepair')
    expect(
      result.steps.filter((step) => step.kind !== 'handoff' && step.reviewRepair)
    ).toHaveLength(2)
  })
})

describe('explicit repair validation', () => {
  it('refuses multiple report-only rounds without inventing repair authority', () => {
    const steps = [{ ...review, maxRounds: 3 }, handoff]
    expect(nextStepOutcomeProblems([outcome(steps)])).toContain(
      'Choose one report-only round, or enable repairs for additional rounds.'
    )
    expect(compile(steps)).toEqual({
      steps: [],
      problems: [{ kind: 'invalid-review-repair', key: 'review' }]
    })
  })

  it.each([2, 3, 4, 5])(
    'preserves every configured reviewer across %i source-repair rounds',
    (maxRounds) => {
      const result = compile([{ ...review, maxRounds, repairWithSource: true }, handoff])
      expect(result.problems).toEqual([])
      expect(result.steps).toHaveLength(maxRounds * 2 + 1)
      for (let round = 1; round <= maxRounds; round += 1) {
        expect(
          result.steps.filter((step) => step.kind !== 'handoff' && step.review?.round === round)
        ).toMatchObject([
          { agent: 'claude', review: { round, maxRounds, repairWithSource: true } },
          { agent: 'codex', review: { round, maxRounds, repairWithSource: true } }
        ])
      }
      expect(result.steps.at(-1)).toMatchObject({
        id: 'outcome_next-agent',
        presetId: 'synthesize'
      })
      expect(result.steps.at(-1)).not.toHaveProperty('reviewRepair')
    }
  )
  it('refuses to turn an orphan repair into an unconditional agent after a reorder', () => {
    const steps = [{ ...handoff, reviewRepair: true }, review]
    expect(nextStepOutcomeProblems([outcome(steps)])).toContain(
      'Place a repair agent immediately after its review, or turn off repair mode.'
    )
    expect(compile(steps)).toEqual({
      steps: [],
      problems: [{ kind: 'invalid-review-repair', key: 'next-agent' }]
    })
  })

  it.each([1, 6])(
    'refuses to silently drop or exceed a repair with %i review rounds',
    (maxRounds) => {
      const steps = [
        { ...review, maxRounds },
        { ...handoff, reviewRepair: true }
      ]
      expect(nextStepOutcomeProblems([outcome(steps)])).toContain(
        'Choose between two and five review rounds when using a repair agent.'
      )
      expect(compile(steps)).toEqual({
        steps: [],
        problems: [{ kind: 'invalid-review-repair', key: 'next-agent' }]
      })
    }
  )

  it('requires a repair owner before saving the loop', () => {
    expect(
      compile([
        { ...review, maxRounds: 3 },
        { ...handoff, actor: null, reviewRepair: true }
      ])
    ).toEqual({
      steps: [],
      problems: [{ kind: 'no-recipients' }]
    })
  })
})
