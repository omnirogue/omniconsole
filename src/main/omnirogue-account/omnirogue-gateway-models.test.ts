import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_GATEWAY_MODELS } from '../../shared/omnirogue-account'
import { getOmniRogueGatewayModels } from './omnirogue-gateway-models'

describe('gateway model discovery', () => {
  it('uses the live catalog, including newly available model IDs', async () => {
    const request = vi.fn(async () => ({
      data: [
        { id: 'claude-opus-5-5', owned_by: 'anthropic' },
        { id: 'gpt-future', owned_by: 'openai', name: 'Future GPT' }
      ]
    }))
    expect(await getOmniRogueGatewayModels(request)).toEqual([
      FALLBACK_GATEWAY_MODELS[0],
      {
        id: 'gpt-future',
        provider: 'openai',
        label: 'Future GPT',
        recommendedAgents: ['codex', 'opencode']
      }
    ])
    expect(request).toHaveBeenCalledWith('/v1/models')
  })

  it.each([null, {}, { data: [] }, { data: [{ id: 42 }, { id: 'unknown' }] }])(
    'falls back for an unusable catalog: %j',
    async (body) => {
      expect(await getOmniRogueGatewayModels(async () => body)).toBe(FALLBACK_GATEWAY_MODELS)
    }
  )

  it('falls back when authentication or the network fails', async () => {
    expect(
      await getOmniRogueGatewayModels(async () => {
        throw new Error('offline')
      })
    ).toBe(FALLBACK_GATEWAY_MODELS)
  })
})
