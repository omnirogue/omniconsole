import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { NextStepActor, NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import {
  localFallbackChoices,
  localFallbackProblem,
  refreshLocalOutcomeProblems,
  reviewerFallbackProblem
} from './local-fallback-selection'
import type { NextStepAvailableAgent } from './use-next-step-recipients'
vi.mock('@/i18n/i18n', () => ({ translate: (key: string) => key }))
const route = ['x-ai/grok-4.5', 'google/gemini-2.5-pro']
const actor: NextStepActor = {
  agent: 'omp',
  model: `openrouter/${route[0]}`,
  openrouterCandidates: route
}
const models: CatalogModel[] = route.map((id) => ({
  id: `openrouter/${id}`,
  label: id,
  options: [],
  openrouterRouting: 'omp-openrouter-routing-v1'
}))
const agent: NextStepAvailableAgent = {
  id: 'omp',
  label: 'OMP',
  cmd: 'omp',
  homepageUrl: '',
  status: 'usable',
  models
}
const handoff: NextStepOutcomeDraft = {
  id: 'outcome',
  finish: { kind: 'complete' },
  instructions: '',
  steps: [{ id: 'handoff', kind: 'handoff', actor, presetId: 'implement', instructions: 'Work' }]
}

describe('execution-host local fallback evidence', () => {
  it('never promotes static catalogs, fleet host membership, or partially attested routes', () => {
    expect(localFallbackChoices(models).map((choice) => choice.id)).toEqual(route)
    const unverified = models.map((model) => ({
      ...model,
      openrouterRouting: undefined,
      hosts: ['local']
    }))
    expect(localFallbackChoices(unverified)).toEqual([])
    expect(localFallbackProblem(actor, unverified)).toBe('nextStep.localFallback.unavailable')
    expect(localFallbackProblem(actor, [models[0]!])).toBe('nextStep.localFallback.missing')
    expect(localFallbackProblem(actor, models)).toBeNull()
    expect(actor.openrouterCandidates).toEqual(route)
  })

  it('requires an explicit primary and exact reviewed order while preserving fixed-only omission', () => {
    expect(localFallbackProblem({ agent: 'omp' }, models)).toBe(
      'nextStep.localFallback.unavailable'
    )
    expect(localFallbackProblem({ ...actor, model: models[1]!.id }, models)).toBe(
      'nextStep.fleetFallback.invalidOrder'
    )
    expect(localFallbackProblem({ agent: 'omp', model: models[0]!.id }, models)).toBeNull()
    expect(localFallbackProblem({ agent: 'codex' }, [])).toBeNull()
  })

  it('rechecks handoff routes before local outcome compilation and refuses revoked evidence', async () => {
    const refresh = vi.fn().mockResolvedValue([agent])
    const original = structuredClone(handoff)
    expect(await refreshLocalOutcomeProblems([handoff], refresh)).toEqual([])
    expect(refresh).toHaveBeenCalledOnce()
    refresh.mockResolvedValue([{ ...agent, models: [models[0]] }])
    expect(await refreshLocalOutcomeProblems([handoff], refresh)).toEqual([
      'nextStep.localFallback.missing'
    ])
    refresh.mockRejectedValue(new Error('Execution host disconnected'))
    expect(await refreshLocalOutcomeProblems([handoff], refresh)).toEqual([
      'Execution host disconnected'
    ])
    expect(handoff).toEqual(original)
  })

  it('keeps reviewer fallback lists refused even on a host with local handoff support', async () => {
    const reviewer: NextStepOutcomeDraft = {
      ...handoff,
      steps: [
        {
          id: 'review',
          kind: 'review',
          reviewers: [actor],
          maxRounds: 1,
          instructions: '',
          adversarial: false
        }
      ]
    }
    const refresh = vi.fn().mockResolvedValue([agent])
    expect(reviewerFallbackProblem(actor)).toBe('nextStep.localFallback.reviewerUnsupported')
    expect(await refreshLocalOutcomeProblems([reviewer], refresh)).toContain(
      'nextStep.localFallback.reviewerUnsupported'
    )
    expect(refresh).not.toHaveBeenCalled()
    expect(reviewerFallbackProblem({ ...actor, openrouterCandidates: undefined })).toBeNull()
  })
})
