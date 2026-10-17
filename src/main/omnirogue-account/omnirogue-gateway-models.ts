import {
  FALLBACK_GATEWAY_MODELS,
  type OmniRogueGatewayModelOption,
  type OmniRogueGatewayProvider
} from '../../shared/omnirogue-account'

function providerFor(model: Record<string, unknown>, id: string): OmniRogueGatewayProvider | null {
  const provider = model.provider ?? model.owned_by
  if (provider === 'anthropic' || provider === 'openai' || provider === 'google') {
    return provider
  }
  if (id.startsWith('claude-')) {
    return 'anthropic'
  }
  if (id.startsWith('gpt-') || /^o\d/.test(id)) {
    return 'openai'
  }
  return id.startsWith('gemini-') ? 'google' : null
}

export async function getOmniRogueGatewayModels(
  request: (path: string) => Promise<unknown>
): Promise<readonly OmniRogueGatewayModelOption[]> {
  try {
    const response = await request('/v1/models')
    if (
      !response ||
      typeof response !== 'object' ||
      !('data' in response) ||
      !Array.isArray(response.data)
    ) {
      return FALLBACK_GATEWAY_MODELS
    }
    const models = new Map<string, OmniRogueGatewayModelOption>()
    for (const entry of response.data) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) {
        continue
      }
      const id = entry.id.trim(),
        provider = providerFor(entry, id)
      if (!provider) {
        continue
      }
      const known = FALLBACK_GATEWAY_MODELS.find((model) => model.id === id)
      const name = entry.name ?? entry.display_name
      models.set(id, {
        id,
        provider,
        label: typeof name === 'string' && name.trim() ? name.trim() : (known?.label ?? id),
        recommendedAgents: known?.recommendedAgents ?? [
          provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'codex' : 'gemini',
          'opencode'
        ]
      })
    }
    return models.size ? [...models.values()] : FALLBACK_GATEWAY_MODELS
  } catch {
    return FALLBACK_GATEWAY_MODELS
  }
}
