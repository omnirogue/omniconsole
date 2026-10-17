import { describe, expect, it } from 'vitest'
import {
  customModelMatches,
  filterOpenRouterModels,
  normalizeCustomModelPresets,
  openRouterProviders
} from './custom-model-presets'

describe('custom model preset persistence', () => {
  it('seeds nothing and drops the retired Ox Alpha seed', () => {
    expect(normalizeCustomModelPresets(undefined)).toEqual([])
    expect(normalizeCustomModelPresets(JSON.parse(JSON.stringify([])))).toEqual([])
    expect(
      normalizeCustomModelPresets([
        { id: 'ox-alpha', name: 'Ox Alpha', modelId: 'stealth/ox-alpha' },
        { id: 'mine', name: 'Mine', modelId: 'stealth/ox-alpha' }
      ])
    ).toEqual([{ id: 'mine', name: 'Mine', modelId: 'stealth/ox-alpha' }])
  })

  it('preserves renamed exact IDs and excludes unknown fields from persisted records', () => {
    const presets = normalizeCustomModelPresets([
      {
        id: 'one',
        name: 'My model',
        modelId: 'vendor/model:free',
        apiKey: 'not-a-real-key'
      },
      { id: 'one', name: 'Duplicate', modelId: 'vendor/other' },
      { id: 'invalid', name: 'Bad', modelId: ' vendor/model' }
    ])
    expect(normalizeCustomModelPresets(JSON.parse(JSON.stringify(presets)))).toEqual([
      { id: 'one', name: 'My model', modelId: 'vendor/model:free' }
    ])
    expect(customModelMatches(presets[0], 'MY MODEL')).toBe(true)
    expect(customModelMatches(presets[0], 'vendor/model:free')).toBe(true)
    expect(customModelMatches(presets[0], 'missing')).toBe(false)
  })

  it('lists providers by model count and filters by provider and every search word', () => {
    const models = [
      { id: 'openai/gpt-5', name: 'OpenAI: GPT-5' },
      { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini' },
      { id: 'x-ai/grok-4', name: 'xAI: Grok 4' }
    ]
    expect(openRouterProviders(models)).toEqual([
      { provider: 'openai', count: 2 },
      { provider: 'x-ai', count: 1 }
    ])
    expect(filterOpenRouterModels(models, 'gpt mini').map((m) => m.id)).toEqual([
      'openai/gpt-5-mini'
    ])
    expect(filterOpenRouterModels(models, '', 'x-ai').map((m) => m.id)).toEqual(['x-ai/grok-4'])
    expect(filterOpenRouterModels(models, 'grok', 'openai')).toEqual([])
  })
})
