import { expect, it } from 'vitest'
import { validOpenRouterRoute } from './openrouter-route'
import { normalizeSessionChainStep } from './session-chain-normalize'

const route = {
  agent: 'omp' as const,
  model: 'openrouter/x-ai/grok-exact:free',
  openrouterCandidates: ['x-ai/grok-exact:free', 'google/gemini-exact']
}
it('retains opaque ordered routing after disk reload and rejects corrupt routes', () => {
  const step = { id: 'step', prompt: 'Do the task', status: 'queued' as const, ...route }
  expect(normalizeSessionChainStep(JSON.parse(JSON.stringify(step)))).toEqual(step)
  for (const candidates of [
    [],
    route.openrouterCandidates.toReversed(),
    ['openrouter/x-ai/grok-exact:free'],
    ['x-ai/grok-exact:free', 'x-ai/grok-exact:free']
  ]) {
    expect(validOpenRouterRoute({ ...route, openrouterCandidates: candidates })).toBe(false)
    expect(normalizeSessionChainStep({ ...step, openrouterCandidates: candidates })).toBeNull()
  }
})
