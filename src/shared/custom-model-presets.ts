import { z } from 'zod'
import { openrouterApiId } from './openrouter-route'

export const CustomModelPresetSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  modelId: openrouterApiId
})
export type CustomModelPreset = z.infer<typeof CustomModelPresetSchema>
export const MAX_CUSTOM_MODEL_PRESETS = 100
export const CUSTOM_MODEL_ID_PLACEHOLDER = 'provider/model'

// The former seed (stealth/ox-alpha) left OpenRouter; drop it from stored settings.
const RETIRED_SEEDS = new Set(['ox-alpha stealth/ox-alpha'])

export function normalizeCustomModelPresets(raw: unknown): CustomModelPreset[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const seen = new Set<string>()
  return raw
    .flatMap((entry) => {
      const parsed = CustomModelPresetSchema.safeParse(entry)
      if (
        !parsed.success ||
        seen.has(parsed.data.id) ||
        RETIRED_SEEDS.has(`${parsed.data.id} ${parsed.data.modelId}`)
      ) {
        return []
      }
      seen.add(parsed.data.id)
      return [parsed.data]
    })
    .slice(0, MAX_CUSTOM_MODEL_PRESETS)
}

export function customModelMatches(preset: CustomModelPreset, search: string): boolean {
  const query = search.trim().toLowerCase()
  return preset.name.toLowerCase().includes(query) || preset.modelId.toLowerCase().includes(query)
}

export function openRouterProvider(modelId: string): string {
  return modelId.split('/')[0]
}

/** Providers with their model counts, most models first. */
export function openRouterProviders(
  models: readonly { id: string }[]
): { provider: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const model of models) {
    const provider = openRouterProvider(model.id)
    counts.set(provider, (counts.get(provider) ?? 0) + 1)
  }
  return [...counts]
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
}

/** Every search word must appear in the model's ID or name; `provider` narrows first. */
export function filterOpenRouterModels<T extends { id: string; name: string }>(
  models: readonly T[],
  search: string,
  provider?: string
): T[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return models.filter((model) => {
    if (provider && openRouterProvider(model.id) !== provider) {
      return false
    }
    const haystack = `${model.id} ${model.name}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
