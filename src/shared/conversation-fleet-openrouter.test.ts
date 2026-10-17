import { expect, it } from 'vitest'
import { assertConversationFleetOpenRouterRoutes } from './conversation-fleet-openrouter'
import type { ConsoleConversationFleetInventory } from './console-conversation-fleet-types'
const ids = ['x-ai/grok-exact', 'google/gemini-exact']
const inventory: ConsoleConversationFleetInventory = {
  providers: ['omp'],
  models_fallback: false,
  people: [],
  repositories: [],
  machines: [
    {
      host: 'worker',
      allowed: true,
      ready: true,
      last_beat: null,
      slots: 1,
      running: 0,
      execution_capabilities: []
    }
  ],
  models: ids.map((id) => ({
    id: `omp:openrouter/${id}`,
    provider: 'omp',
    model: `openrouter/${id}`,
    supported_efforts: [],
    default: false,
    seat_ready: true,
    aliases: [],
    hosts: ['worker']
  }))
}
it('requires every candidate on the exact advertised host without static model substitution', () => {
  const step = {
    title: 'run',
    actor_id: `omp:openrouter/${ids[0]}`,
    machine: 'worker',
    openrouter_candidates: ids
  }
  expect(() => assertConversationFleetOpenRouterRoutes([step], inventory)).not.toThrow()
  expect(() =>
    assertConversationFleetOpenRouterRoutes([{ ...step, machine: undefined }], inventory)
  ).toThrow()
  const missing = structuredClone(inventory)
  delete missing.models[1].hosts
  expect(() => assertConversationFleetOpenRouterRoutes([step], missing)).toThrow()
  expect(() =>
    assertConversationFleetOpenRouterRoutes(
      [{ ...step, openrouter_candidates: undefined }],
      missing
    )
  ).not.toThrow()
  expect(() =>
    assertConversationFleetOpenRouterRoutes([step], { ...inventory, models_fallback: true })
  ).toThrow()
})
