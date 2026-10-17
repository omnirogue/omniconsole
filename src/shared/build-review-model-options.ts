import { createOmpCatalogModel } from './agent-session-option-catalog-omp'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'
import {
  createClaudeCatalogOptions,
  getAgentSessionOptionCatalog,
  type CatalogModel,
  type CatalogOption
} from './agent-session-option-catalog'

export type BuildReviewChoiceOption = { value: string; label: string; description?: string }

/** Sentinel select value meaning "leave the flag off and let the agent decide". */
export const BUILD_REVIEW_AGENT_DEFAULT = '__agent-default__'

function effortOptionFromLevels(
  levels: readonly { id: string; label: string }[],
  defaultLevel: string | undefined
): CatalogOption {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: levels.map((level) => ({ value: level.id, label: level.label })),
      defaultValue: defaultLevel ?? levels[0]?.id ?? ''
    },
    apply: {}
  }
}

/** Turn a host probe result into catalog rows that carry each model's real effort levels. */
export function catalogModelsFromDiscovery(
  agent: string,
  models: readonly CommitMessageModelCapability[]
): CatalogModel[] {
  if (agent === 'omp') {
    return models.map(createOmpCatalogModel)
  }
  return models.map((model) => ({
    ...(model.openrouterRouting ? { openrouterRouting: model.openrouterRouting } : {}),
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true as const } : {}),
    options:
      agent === 'claude'
        ? createClaudeCatalogOptions({
            effortLevelIds: model.thinkingLevels?.map(({ id }) => id) ?? [],
            supportsFastMode: model.supportsFastMode
          })
        : model.thinkingLevels?.length
          ? [effortOptionFromLevels(model.thinkingLevels, model.defaultThinkingLevel)]
          : []
  }))
}

/**
 * Probe results decide membership — a seeded id the CLI has retired must not be
 * offered, and a model the seed never heard of must be. The seed only lends its
 * option menus to probed rows that came back without their own.
 */
export function resolveBuildReviewModels(
  agent: string,
  discovered: readonly CatalogModel[] | null
): CatalogModel[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!discovered || discovered.length === 0) {
    return catalog?.models ?? []
  }
  const seed = catalog?.models ?? []
  const inherited = (seed.find((model) => model.isDefault) ?? seed[0])?.options ?? []
  return discovered.map((model) => {
    if (model.options.length > 0) {
      return model
    }
    const seeded = seed.find((candidate) => candidate.id === model.id)
    return { ...model, options: seeded?.options ?? inherited }
  })
}

export function modelChoicesFor(models: readonly CatalogModel[]): BuildReviewChoiceOption[] {
  return models.map((model) => ({
    value: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {})
  }))
}

function effortOption(model: CatalogModel | undefined): CatalogOption | undefined {
  return model?.options.find((option) => option.id === 'effort' && option.kind.type === 'select')
}

/** Effort levels the chosen model advertises; unknown ids fall back to the agent's generic menu. */
export function effortChoicesFor(
  agent: string,
  models: readonly CatalogModel[],
  modelId: string | undefined
): BuildReviewChoiceOption[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined
  const option =
    effortOption(model) ??
    (modelId && !model
      ? catalog?.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
      : undefined) ??
    (modelId
      ? undefined
      : effortOption(models.find((candidate) => candidate.isDefault) ?? models[0]))
  if (!option || option.kind.type !== 'select') {
    return []
  }
  return option.kind.choices.map((choice) => ({ value: choice.value, label: choice.label }))
}
