import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { NextStepActor } from '../../../../shared/next-step-draft'
import { fleetFallbackChoices, fleetFallbackProblem } from './fleet-fallback-selection'
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string) => key
}))
const route = ['x-ai/grok-4.5', 'moonshotai/kimi-k2.5', 'google/gemini-2.5-pro']
const actor: NextStepActor = {
  agent: 'omp',
  model: `openrouter/${route[0]}`,
  openrouterCandidates: route
}
const models: CatalogModel[] = route.map((id) => ({
  id: `openrouter/${id}`,
  label: id,
  options: [],
  hosts: ['first']
}))

describe('reviewed fleet fallback selection', () => {
  it('keeps backend model membership and explicit selected host authority', () => {
    expect(fleetFallbackChoices(models)).toEqual([])
    expect(fleetFallbackChoices(models, 'second')).toEqual([])
    expect(fleetFallbackChoices(models, 'first').map((choice) => choice.id)).toEqual(route)
    expect(fleetFallbackChoices([{ ...models[0]!, hosts: undefined }], 'first')).toEqual([])
    expect(fleetFallbackChoices([{ ...models[0]!, id: 'google/gemini-2.5-pro' }], 'first')).toEqual(
      []
    )
    expect(fleetFallbackChoices([], 'first')).toEqual([])
  })

  it('requires every candidate on the same host without reordering or borrowing another host', () => {
    expect(fleetFallbackProblem(actor, models, 'first')).toBeNull()
    const changed = models.map((model, index) =>
      index === 1 ? { ...model, hosts: ['second'] } : model
    )
    const saved = structuredClone(actor)
    expect(fleetFallbackProblem(actor, changed, 'first')).toBe(
      'nextStep.fleetFallback.candidatesUnavailable'
    )
    expect(fleetFallbackProblem(actor, changed, 'second')).toBe(
      'nextStep.fleetFallback.primaryUnavailable'
    )
    expect(actor).toEqual(saved)
    expect(fleetFallbackProblem(actor, models, 'first')).toBeNull()
  })

  it('refuses automatic hosts and local fallback use while keeping fixed-only local actors valid', () => {
    expect(fleetFallbackProblem(actor, models)).toBe('nextStep.fleetFallback.chooseHost')
    expect(fleetFallbackProblem(actor, undefined)).toBe('nextStep.fleetFallback.fleetOnly')
    expect(
      fleetFallbackProblem({ ...actor, openrouterCandidates: undefined }, undefined)
    ).toBeNull()
    expect(
      fleetFallbackProblem({ ...actor, openrouterCandidates: undefined }, models, 'first')
    ).toBeNull()
    expect(fleetFallbackProblem({ agent: 'omp' }, models, 'first')).toBe(
      'nextStep.fleetFallback.primaryUnavailable'
    )
  })

  it.each([
    { ...actor, model: `openrouter/${route[1]}` },
    { ...actor, agent: 'codex' as const },
    { ...actor, openrouterCandidates: [] },
    { ...actor, openrouterCandidates: [route[0]!, route[0]!] },
    { ...actor, openrouterCandidates: [`openrouter/${route[0]}`] }
  ])('requires explicit repair of an invalid saved route: %j', (changed) => {
    const saved = structuredClone(changed)
    expect(fleetFallbackProblem(changed, models, 'first')).toBe(
      'nextStep.fleetFallback.invalidOrder'
    )
    expect(changed).toEqual(saved)
  })
})
