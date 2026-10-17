import { expect, it } from 'vitest'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import { nextReviewerSeat, pinOutcomeExactModels } from './next-step-reviewer-seat'

const model = (id: string, isDefault = false) => ({
  id,
  label: id,
  options: [],
  ...(isDefault ? { isDefault } : {})
})
const codex = {
  id: 'codex',
  label: 'Codex',
  models: [model('gpt-a'), model('gpt-b', true)]
} as const
const claude = {
  id: 'claude',
  label: 'Claude',
  models: [model('opus'), model('sonnet', true)]
} as const
const grok = { id: 'grok', label: 'Grok', models: [model('grok-x', true)] } as const
const gemini = { id: 'gemini', label: 'Gemini', models: [model('auto', true)] } as const

it('prefers the next unused lineage among usable agents, at its default model', () => {
  expect(nextReviewerSeat([gemini, grok, claude, codex], [])).toEqual({
    agent: 'codex',
    model: 'gpt-b'
  })
  expect(
    nextReviewerSeat([gemini, grok, claude, codex], [{ agent: 'codex', model: 'gpt-b' }])
  ).toEqual({
    agent: 'claude',
    model: 'sonnet'
  })
  expect(
    nextReviewerSeat([claude, grok], [{ agent: 'claude' }, { agent: 'codex', model: 'gpt-b' }])
  ).toEqual({ agent: 'grok', model: 'grok-x' })
})

it('uses an unused exact model of a taken lineage once every lineage is seated', () => {
  expect(
    nextReviewerSeat(
      [codex, claude],
      [
        { agent: 'codex', model: 'gpt-b' },
        { agent: 'claude', model: 'sonnet' }
      ]
    )
  ).toEqual({ agent: 'codex', model: 'gpt-a' })
})

it('falls back to a colliding default only when no exact model is free', () => {
  expect(nextReviewerSeat([grok], [{ agent: 'grok', model: 'grok-x' }])).toEqual({
    agent: 'grok',
    model: 'grok-x'
  })
  expect(nextReviewerSeat([], [])).toBeNull()
})

it('fills in the static catalog default when a host lists no models', () => {
  expect(nextReviewerSeat([{ id: 'claude' }], [])).toEqual({ agent: 'claude', model: 'opus' })
})

function outcome(steps: NextStepOutcomeDraft['steps']): NextStepOutcomeDraft {
  return { id: 'o', finish: { kind: 'complete' }, instructions: '', steps }
}

it('pins Default model choices to exact models before a card-attached save', () => {
  const result = pinOutcomeExactModels(
    [
      outcome([
        {
          id: 'h',
          kind: 'handoff',
          actor: { agent: 'codex' },
          presetId: 'implement',
          instructions: ''
        },
        {
          id: 'r',
          kind: 'review',
          maxRounds: 2,
          instructions: '',
          adversarial: false,
          reviewers: [
            { agent: 'claude', effort: 'high' },
            { agent: 'grok', model: 'grok-x' }
          ]
        }
      ])
    ],
    [codex, claude, grok]
  )
  expect(result.problem).toBeNull()
  expect(result.outcomes[0]!.steps).toMatchObject([
    { actor: { agent: 'codex', model: 'gpt-b' } },
    {
      reviewers: [
        { agent: 'claude', model: 'sonnet', effort: 'high' },
        { agent: 'grok', model: 'grok-x' }
      ]
    }
  ])
})

it('names an explicit model the host does not list instead of saving it', () => {
  const review = outcome([
    {
      id: 'r',
      kind: 'review',
      maxRounds: 1,
      instructions: '',
      adversarial: false,
      reviewers: [{ agent: 'claude', model: 'opus' }]
    }
  ])
  const sonnetOnly = { ...claude, models: [model('sonnet', true)] }
  expect(pinOutcomeExactModels([review], [sonnetOnly]).problem).toBe(
    'Reviewer 1 (Claude) uses opus, which is unavailable on this host. Choose another model.'
  )
  expect(pinOutcomeExactModels([review], [codex]).problem).toMatch(/opus.*unavailable/)
  // A host that reported no catalog is unknown; absence is never evidence that opus runs.
  expect(pinOutcomeExactModels([review], [{ id: 'claude', label: 'Claude' }]).problem).toMatch(
    /could not be verified.*has not reported which models/
  )
  // An empty catalog from a host that did answer is a refusal, not unknown.
  expect(
    pinOutcomeExactModels(
      [review],
      [{ id: 'claude', label: 'Claude', models: [], modelsProbed: true }]
    ).problem
  ).toMatch(/opus.*unavailable/)
})

it('lets independent reviewers share the only model a single-model host lists', () => {
  const sonnetOnly = { ...claude, models: [model('sonnet', true)] }
  const shared = outcome([
    {
      id: 'r',
      kind: 'review',
      maxRounds: 1,
      instructions: '',
      adversarial: false,
      reviewers: [
        { agent: 'claude', model: 'sonnet' },
        { agent: 'claude', model: 'sonnet' }
      ]
    }
  ])
  expect(pinOutcomeExactModels([shared], [sonnetOnly]).problem).toBeNull()
})

it('never proposes an agent a task-attached plan cannot compile', () => {
  expect(nextReviewerSeat([gemini], [])).toBeNull()
  expect(nextReviewerSeat([gemini, grok], [{ agent: 'grok', model: 'grok-x' }])).toEqual({
    agent: 'grok',
    model: 'grok-x'
  })
})

it('names the seat a task-attached plan cannot run instead of throwing at save', () => {
  const review = (reviewers: { agent: 'gemini' | 'grok' }[]) =>
    outcome([
      { id: 'r', kind: 'review', maxRounds: 1, instructions: '', adversarial: false, reviewers }
    ])
  expect(
    pinOutcomeExactModels([review([{ agent: 'grok' }, { agent: 'gemini' }])], [grok, gemini])
      .problem
  ).toBe(
    'Reviewer 2 uses Gemini, which a task-attached plan cannot run. Choose Codex, Claude or Grok.'
  )
  expect(pinOutcomeExactModels([review([{ agent: 'grok' }])], []).problem).toBe(
    'Reviewer 1 (grok) has no known default model on this host. Choose its model.'
  )
})

it('allows task-bound OMP handoffs only with exact host-attested models and keeps reviewer seats restricted', () => {
  const actor = {
    agent: 'omp' as const,
    model: 'openrouter/x-ai/grok-4.5',
    openrouterCandidates: ['x-ai/grok-4.5']
  }
  const agent = {
    id: 'omp' as const,
    label: 'OMP',
    models: [
      {
        id: actor.model,
        label: 'Grok',
        options: [],
        openrouterRouting: 'omp-openrouter-routing-v1' as const
      }
    ]
  }
  const outcome: NextStepOutcomeDraft = {
    id: 'omp',
    finish: { kind: 'complete' },
    instructions: '',
    steps: [{ id: 'handoff', kind: 'handoff', actor, presetId: 'implement', instructions: '' }]
  }
  expect(pinOutcomeExactModels([outcome], [agent]).problem).toBeNull()
  expect(
    pinOutcomeExactModels(
      [outcome],
      [{ ...agent, models: [{ ...agent.models[0]!, openrouterRouting: undefined }] }]
    ).problem
  ).not.toBeNull()
  outcome.steps = [
    {
      id: 'review',
      kind: 'review',
      reviewers: [actor],
      maxRounds: 1,
      instructions: '',
      adversarial: false
    }
  ]
  expect(pinOutcomeExactModels([outcome], [agent]).problem).not.toBeNull()
})
