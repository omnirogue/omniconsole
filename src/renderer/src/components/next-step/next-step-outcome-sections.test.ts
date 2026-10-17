import { describe, expect, it } from 'vitest'
import {
  defaultNextStepInstructions,
  emptyNextStepOutcomeDraft,
  type NextStepOutcomeDraft
} from '../../../../shared/next-step-draft'
import {
  appendOutcomeSteps,
  clampReviewRounds,
  defaultNextStepOutcomeDraft,
  describeReviewer,
  extraReviewStepCount,
  finishForNextPerson,
  finishWithTeammateMode,
  handoffWithPreset,
  moveHandoffStep,
  moveOutcomeStep,
  newHandoffStep,
  newReviewStep,
  nextPersonChoice,
  outcomeHandoffSteps,
  outcomeReviewStep,
  removeOutcomeStep,
  replaceOutcomeStep,
  reviewerSeats,
  reviewersFromSeats,
  stepBeforeReview,
  teammateMode,
  withDefaultFinish,
  withHandoffSteps,
  withReviewStep,
  type NextStepHandoffStep,
  type NextStepPersonFinish,
  type NextStepReviewStep
} from './next-step-outcome-sections'

const handoff = (
  id: string,
  agent: 'codex' | 'claude' | 'grok' = 'codex'
): NextStepHandoffStep => ({
  id,
  kind: 'handoff',
  actor: { agent },
  presetId: 'implement',
  instructions: `Instruction ${id}`
})
const review = (id: string): NextStepReviewStep => ({
  id,
  kind: 'review',
  reviewers: [{ agent: 'claude' }],
  maxRounds: 2,
  instructions: '',
  adversarial: false
})
const outcome = (steps: NextStepOutcomeDraft['steps']): NextStepOutcomeDraft => ({
  ...emptyNextStepOutcomeDraft(),
  id: 'outcome',
  finish: { kind: 'complete' },
  steps
})

describe('defaults', () => {
  it('starts a fresh outcome at Me and reads an unset finish as Me', () => {
    expect(defaultNextStepOutcomeDraft().finish).toEqual({ kind: 'complete' })
    expect(withDefaultFinish({ ...emptyNextStepOutcomeDraft(), finish: null }).finish).toEqual({
      kind: 'complete'
    })
    const person = outcome([])
    person.finish = {
      kind: 'person',
      personId: 'a',
      personName: 'A',
      disposition: 'ownership',
      action: 'review'
    }
    expect(withDefaultFinish(person)).toBe(person)
  })
})

describe('review step', () => {
  it('inserts a new review before the agents and replaces or removes it in place', () => {
    const base = outcome([handoff('a'), handoff('b')])
    const added = withReviewStep(base, review('r'))
    expect(added.steps.map((step) => step.id)).toEqual(['r', 'a', 'b'])
    const edited = withReviewStep(added, { ...review('r'), maxRounds: 4 })
    expect(edited.steps.map((step) => step.id)).toEqual(['r', 'a', 'b'])
    expect(outcomeReviewStep(edited)?.maxRounds).toBe(4)
    expect(withReviewStep(edited, null).steps.map((step) => step.id)).toEqual(['a', 'b'])
    expect(withReviewStep(base, null)).toBe(base)
  })

  it('keeps a legacy producer-then-review order and counts extra review steps', () => {
    const legacy = outcome([handoff('producer'), review('r1'), review('r2')])
    expect(stepBeforeReview(legacy)?.id).toBe('producer')
    expect(outcomeReviewStep(legacy)?.id).toBe('r1')
    expect(extraReviewStepCount(legacy)).toBe(1)
    const edited = withReviewStep(legacy, { ...review('r1'), adversarial: true })
    expect(edited.steps.map((step) => step.id)).toEqual(['producer', 'r1', 'r2'])
  })

  it('maps reviewers to Build + Review seats and back without dropping an account override', () => {
    const reviewers = [
      { agent: 'codex' as const, model: 'gpt-6-astra', effort: 'high', accountChoiceId: 'acct' },
      { agent: 'claude' as const }
    ]
    const seats = reviewerSeats(reviewers)
    expect(seats).toEqual([
      { id: 0, choice: { agent: 'codex', model: 'gpt-6-astra', effort: 'high' } },
      { id: 1, choice: { agent: 'claude' } }
    ])
    expect(
      reviewersFromSeats(
        [
          { id: 0, choice: { agent: 'codex', model: 'gpt-6-astra' } },
          { id: 1, choice: { agent: 'grok' } },
          { id: 2, choice: { agent: 'claude', effort: 'max' } }
        ],
        reviewers
      )
    ).toEqual([
      { agent: 'codex', model: 'gpt-6-astra', accountChoiceId: 'acct' },
      { agent: 'grok' },
      { agent: 'claude', effort: 'max' }
    ])
    expect(
      reviewersFromSeats(
        Array.from({ length: 7 }, (_, id) => ({ id, choice: { agent: 'codex' } })),
        []
      )
    ).toHaveLength(5)
  })

  it('clamps rounds to the outcome limit and starts a review with one reviewer and three rounds', () => {
    expect(clampReviewRounds(9)).toBe(5)
    expect(clampReviewRounds(0)).toBe(1)
    expect(clampReviewRounds(Number.NaN)).toBe(1)
    expect(newReviewStep({ agent: 'grok' })).toMatchObject({
      kind: 'review',
      reviewers: [{ agent: 'grok' }],
      maxRounds: 3,
      repairWithSource: true,
      adversarial: false
    })
    expect(newReviewStep(null).reviewers).toEqual([])
    expect(newReviewStep(null, 9).maxRounds).toBe(5)
  })

  it('carries three reviewers with their own agents, models and efforts through the seats and into the summary', () => {
    const reviewers = [
      { agent: 'claude' as const, model: 'opus', effort: 'high' },
      { agent: 'codex' as const, model: 'gpt-6-astra' },
      { agent: 'grok' as const }
    ]
    const roundTrip = reviewersFromSeats(reviewerSeats(reviewers), reviewers)
    expect(roundTrip).toEqual(reviewers)
    const name = (agent: string) => agent[0]!.toUpperCase() + agent.slice(1)
    expect(roundTrip.map((actor) => describeReviewer(actor, name))).toEqual([
      'Claude opus high',
      'Codex gpt-6-astra',
      'Grok'
    ])
  })
})

describe('the one Agents list', () => {
  it('edits steps by position, so reviews and agents interleave as saved', () => {
    const base = outcome([handoff('a'), review('r'), handoff('b')])
    expect(replaceOutcomeStep(base, 1, { ...review('r'), maxRounds: 5 }).steps[1]).toMatchObject({
      id: 'r',
      maxRounds: 5
    })
    expect(moveOutcomeStep(base, 1, 1).steps.map((step) => step.id)).toEqual(['a', 'b', 'r'])
    expect(moveOutcomeStep(base, 0, -1).steps.map((step) => step.id)).toEqual(['a', 'r', 'b'])
    expect(removeOutcomeStep(base, 0).steps.map((step) => step.id)).toEqual(['r', 'b'])
    expect(
      appendOutcomeSteps(base, [handoff('c'), review('r2')]).steps.map((step) => step.id)
    ).toEqual(['a', 'r', 'b', 'c', 'r2'])
  })
})

describe('agent steps', () => {
  it('refills handoff slots in order, keeps the review where it was and appends new agents', () => {
    const base = outcome([handoff('a'), review('r'), handoff('b')])
    const swapped = withHandoffSteps(base, moveHandoffStep(outcomeHandoffSteps(base), 0, 1))
    expect(swapped.steps.map((step) => step.id)).toEqual(['b', 'r', 'a'])
    const grown = withHandoffSteps(base, [handoff('a'), handoff('b'), handoff('c')])
    expect(grown.steps.map((step) => step.id)).toEqual(['a', 'r', 'b', 'c'])
    const shrunk = withHandoffSteps(base, [handoff('b')])
    expect(shrunk.steps.map((step) => step.id)).toEqual(['b', 'r'])
    expect(moveHandoffStep([handoff('a')], 0, -1)).toEqual([handoff('a')])
  })

  it('pre-fills a new agent from its preset and refreshes untouched instructions on a preset change', () => {
    const step = newHandoffStep({ agent: 'codex' })
    expect(step).toMatchObject({
      kind: 'handoff',
      presetId: 'implement',
      instructions: defaultNextStepInstructions('implement')
    })
    expect(handoffWithPreset(step, 'research').instructions).toBe(
      defaultNextStepInstructions('research')
    )
    const edited = { ...step, instructions: 'Ship the landing page.' }
    expect(handoffWithPreset(edited, 'research')).toMatchObject({
      presetId: 'research',
      instructions: 'Ship the landing page.'
    })
  })
})

describe('next person', () => {
  it('reads complete, my-review and null as Me, a person as Team and GitHub as legacy', () => {
    expect(nextPersonChoice(null)).toBe('me')
    expect(nextPersonChoice({ kind: 'complete' })).toBe('me')
    expect(nextPersonChoice({ kind: 'my-review' })).toBe('me')
    expect(
      nextPersonChoice({
        kind: 'person',
        personId: '',
        personName: '',
        disposition: 'ownership',
        action: 'review'
      })
    ).toBe('team')
    expect(nextPersonChoice({ kind: 'github', action: 'create-pr' })).toBe('github')
  })

  it('writes the finish each choice means', () => {
    expect(finishForNextPerson('me')).toEqual({ kind: 'complete' })
    expect(finishForNextPerson('team')).toEqual({
      kind: 'person',
      personId: '',
      personName: '',
      disposition: 'ownership',
      action: 'review'
    })
  })

  it('maps Review to feedback that returns and Hand off to ownership that moves', () => {
    const josh: NextStepPersonFinish = {
      kind: 'person',
      personId: 'josh',
      personName: 'Josh',
      disposition: 'ownership',
      action: 'review'
    }
    expect(teammateMode(josh)).toBe('handoff')
    const review = finishWithTeammateMode(josh, 'review')
    expect(review).toMatchObject({ disposition: 'feedback', action: 'review', personId: 'josh' })
    expect(teammateMode(review)).toBe('review')
    expect(finishWithTeammateMode(review, 'handoff')).toMatchObject({
      disposition: 'ownership',
      action: 'review'
    })
  })
})

it('retains unsupported saved reviewer routes until explicitly cleared, even after model or agent edits', () => {
  const previous = [
    {
      agent: 'omp' as const,
      model: 'openrouter/x-ai/grok-4.5',
      openrouterCandidates: ['x-ai/grok-4.5', 'google/gemini-2.5-pro']
    }
  ]
  for (const choice of [
    { agent: 'omp', model: 'openrouter/google/gemini-2.5-pro' },
    { agent: 'codex', model: 'gpt-6-astra' }
  ]) {
    const result = reviewersFromSeats([{ id: 0, choice }], previous)
    expect(result[0]).toMatchObject({
      ...choice,
      openrouterCandidates: previous[0]!.openrouterCandidates
    })
    expect(result[0]!.openrouterCandidates).not.toBe(previous[0]!.openrouterCandidates)
  }
})
