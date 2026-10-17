import { describe, expect, it } from 'vitest'
import { emptyNextStepDraft } from '../../../../shared/next-step-draft'
import type { NextStepAfterStep, NextStepAgentRecipient } from '../../../../shared/next-step-draft'
import { afterStepRecipient, recipientAfterStep } from './next-step-after-actor'
import { draftWithLevels, pickLevelRecipient } from './add-next/menu-levels'
const route = ['google/gemini-pro', 'moonshotai/kimi-code', 'x-ai/grok-code']
const recipient: NextStepAgentRecipient = {
  kind: 'agent',
  key: 'omp',
  agent: 'omp',
  model: `openrouter/${route[0]}`,
  openrouterCandidates: route,
  presetId: 'implement',
  instructions: 'Build it',
  rounds: 1
}

describe('ordered fallback actor projections', () => {
  it('keeps the exact route through editing a follow-on step', () => {
    const step: Extract<NextStepAfterStep, { kind: 'agent' }> = {
      kind: 'agent',
      key: 'step',
      actor: { agent: 'omp', model: recipient.model, openrouterCandidates: route },
      presetId: 'implement',
      instructions: 'Build',
      rounds: 1,
      level: 3
    }
    const edited = { ...afterStepRecipient(step), instructions: 'Review the retained route' }
    expect(recipientAfterStep(edited, step)).toEqual({ ...step, instructions: edited.instructions })
  })
  it('preserves ordered API IDs in a later menu level actor, not top-level step metadata', () => {
    const draft = draftWithLevels(emptyNextStepDraft(), [
      { mode: 'handoff', recipients: [recipient] },
      { mode: 'handoff', recipients: [recipient] }
    ])
    expect(draft.recipients[0]).toMatchObject({
      model: recipient.model,
      openrouterCandidates: route
    })
    expect(draft.after[0]).toMatchObject({
      actor: { model: recipient.model, openrouterCandidates: route }
    })
    expect(draft.after[0]).not.toHaveProperty('openrouterCandidates')
  })
  it('copies the reviewed model and route together when adding a matching parallel agent', () => {
    const selected = pickLevelRecipient(
      { mode: 'review', recipients: [recipient] },
      {
        ...recipient,
        key: 'second',
        model: 'openrouter/x-ai/grok-code',
        openrouterCandidates: ['x-ai/grok-code']
      }
    )
    expect(selected.recipients[1]).toMatchObject({
      model: recipient.model,
      openrouterCandidates: route
    })
  })
})
