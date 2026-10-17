import { expect, it } from 'vitest'
import type { NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import { defaultActor, defaultReviewer } from './next-step-default-actor'
import { defaultModelFor } from './next-step-reviewer-seat'

const codex = { id: 'codex', label: 'Codex' } as never
const claude = { id: 'claude', label: 'Claude' } as never
const grok = { id: 'grok', label: 'Grok' } as never
const exact = (agent: 'codex' | 'claude' | 'grok') => ({
  agent,
  model: defaultModelFor({ id: agent })
})
const producer = (
  agent: 'codex' | 'claude'
): Extract<NextStepOutcomeStep, { kind: 'handoff' }> => ({
  id: 'producer',
  kind: 'handoff',
  actor: { agent },
  presetId: 'implement',
  instructions: ''
})

it('starts a review with an exact default model on a lineage distinct from its handoff', () => {
  expect(defaultActor([codex, claude], producer('codex'))).toEqual(exact('claude'))
  expect(defaultActor([codex, claude], undefined)).toEqual(exact('codex'))
  expect(exact('codex').model).toBeTruthy()
})

it('skips seated lineages and then picks an unused exact model before colliding', () => {
  expect(defaultActor([codex, claude, grok], producer('codex'), [{ agent: 'claude' }])).toEqual(
    exact('grok')
  )
  const next = defaultActor([codex, claude, grok], producer('codex'), [
    exact('claude'),
    exact('grok')
  ])
  expect(next?.model).toBeTruthy()
  expect(next).not.toEqual(exact('claude'))
  expect(next).not.toEqual(exact('grok'))
})

it('offers another exact model of the only agent when its default is already taken', () => {
  const taken: NextStepOutcomeStep = { ...producer('codex'), actor: exact('codex') }
  const next = defaultActor([codex], taken)
  expect(next?.agent).toBe('codex')
  expect(next?.model).toBeTruthy()
  expect(next?.model).not.toBe(exact('codex').model)
})

it('returns null when no agent is available', () => {
  expect(defaultActor([], undefined)).toBeNull()
})

it('seeds a new review with Build & Review’s default reviewer only when Claude is usable and free', () => {
  const seed = { agent: 'claude', model: 'opus', effort: 'high' }
  expect(defaultReviewer([codex, claude], undefined)).toEqual(seed)
  expect(defaultReviewer([codex, claude], producer('codex'))).toEqual(seed)
  expect(defaultReviewer([codex, grok], producer('codex'))).toEqual(exact('grok'))
  const claudeOpus: NextStepOutcomeStep = {
    ...producer('claude'),
    actor: { agent: 'claude', model: 'opus' }
  }
  expect(defaultReviewer([codex, claude], claudeOpus)).toEqual(exact('codex'))
  expect(defaultReviewer([], claudeOpus)).toBeNull()
})

it('uses the host-reported Claude default when that host does not list opus', () => {
  const sonnetOnly = {
    id: 'claude' as const,
    label: 'Claude',
    models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true, options: [] }]
  }
  expect(defaultReviewer([sonnetOnly], undefined)).toEqual({ agent: 'claude', model: 'sonnet' })
})
