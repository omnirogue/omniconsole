import { expect, it } from 'vitest'
import { defaultNextStepInstructions, emptyNextStepDraft } from '../../../../shared/next-step-draft'
import { compileNextStepChain } from '../../../../shared/next-step-compile'
import {
  NEXT_STEP_OUTCOME_TEMPLATE_IDS,
  outcomeTemplateHandoffCount,
  outcomeTemplateSteps
} from './next-step-outcome-templates'

const codex = { id: 'codex', label: 'Codex' } as never
const claude = { id: 'claude', label: 'Claude' } as never
const grok = { id: 'grok', label: 'Grok' } as never

it('offers the templates the two step kinds can say, and leaves Compare answers out', () => {
  expect([...NEXT_STEP_OUTCOME_TEMPLATE_IDS]).toEqual([
    'research-plan',
    'research-plan-create',
    'council'
  ])
})

it('unfolds Research → Plan (→ Create) into sequential handoffs by the default agent', () => {
  const steps = outcomeTemplateSteps('research-plan', [codex, claude], undefined)!
  expect(steps.map((step) => (step.kind === 'handoff' ? step.presetId : step.kind))).toEqual([
    'research',
    'plan'
  ])
  expect(steps[0]).toMatchObject({
    actor: { agent: 'codex' },
    instructions: defaultNextStepInstructions('research')
  })
  expect(
    outcomeTemplateSteps('research-plan-create', [codex], undefined)!.map((step) =>
      step.kind === 'handoff' ? step.presetId : step.kind
    )
  ).toEqual(['research', 'plan', 'implement'])
})

it('seats up to three distinct reviewers for the Council, then one agent synthesizes', () => {
  const steps = outcomeTemplateSteps('council', [codex, claude, grok], undefined)!
  expect(steps[0]).toMatchObject({
    kind: 'review',
    reviewers: [{ agent: 'codex' }, { agent: 'claude' }, { agent: 'grok' }],
    maxRounds: 1
  })
  expect(steps[1]).toMatchObject({ kind: 'handoff', presetId: 'synthesize' })
  const compiled = compileNextStepChain({
    draft: {
      ...emptyNextStepDraft(),
      outcomes: [{ id: 'council', instructions: '', finish: { kind: 'complete' }, steps }]
    },
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Council',
    defaultNote: 'Council',
    now: 1,
    mintStepId: (index) => `step_${index}`,
    mintOperationId: () => 'handoff'
  })
  expect(compiled.problems).toEqual([])
  expect(compiled.steps).toHaveLength(4)
  expect(compiled.steps[3]).toMatchObject({ presetId: 'synthesize', agent: 'codex' })
  expect(compiled.steps[3]).not.toHaveProperty('reviewRepair')
  expect(
    (outcomeTemplateSteps('council', [codex, claude], undefined)![0] as { reviewers: unknown[] })
      .reviewers
  ).toHaveLength(2)
})

it('adds nothing on a host without agents and counts the agents a template appends', () => {
  expect(outcomeTemplateSteps('research-plan', [], undefined)).toBeNull()
  expect(outcomeTemplateHandoffCount('research-plan')).toBe(2)
  expect(outcomeTemplateHandoffCount('research-plan-create')).toBe(3)
  expect(outcomeTemplateHandoffCount('council')).toBe(1)
})

it('gives every Council seat an exact model on a lineage distinct from its producer', () => {
  const producer = {
    id: 'producer',
    kind: 'handoff' as const,
    actor: { agent: 'codex' as const, model: 'gpt-5.6-sol' },
    presetId: 'implement' as const,
    instructions: ''
  }
  const review = outcomeTemplateSteps('council', [codex, claude, grok], producer)![0] as {
    reviewers: { agent: string; model?: string }[]
  }
  expect(review.reviewers.map((reviewer) => reviewer.agent)).toEqual(['claude', 'grok', 'codex'])
  expect(review.reviewers.every((reviewer) => reviewer.model)).toBe(true)
  const keys = [producer.actor, ...review.reviewers].map((a) => `${a.agent}:${a.model}`)
  expect(new Set(keys).size).toBe(keys.length)
})
