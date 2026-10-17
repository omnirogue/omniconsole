import { assertOpenRouterRoute, openrouterCandidates } from './openrouter-route'
import type { AgentType } from './agent-status-types'
import { findCatalogModel, getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { SessionOptionValue } from './native-chat-session-options'

export type ResolvedSessionOptionLaunch = {
  args: string[]
  appliedValues: Record<string, SessionOptionValue>
}

export function removeOverriddenAgentSessionArgs(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  tokens: readonly string[]
): string[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values) {
    return [...tokens]
  }
  let result = modelId ? (catalog.modelApply.removeAgentArgs?.(tokens) ?? [...tokens]) : [...tokens]
  const model = modelId ? findCatalogModel(catalog, modelId) : undefined
  const modelOptions = model?.options ?? catalog.unknownModelOptions ?? []
  for (const option of modelOptions) {
    if (values[option.id] !== undefined && option.apply.removeAgentArgs) {
      result = option.apply.removeAgentArgs(result)
    }
  }
  return result
}

export function resolveAgentSessionOptionLaunch(
  agent: AgentType,
  values: Record<string, SessionOptionValue> | null | undefined,
  trailingAgentArgs: readonly string[] = [],
  includeCatalogDefaults = true
): ResolvedSessionOptionLaunch {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = typeof values?.model === 'string' ? values.model : null
  if (!catalog || !values) {
    return { args: [], appliedValues: {} }
  }

  const model = modelId ? findCatalogModel(catalog, modelId) : undefined
  const appliedValues: Record<string, SessionOptionValue> = {}
  const args: string[] = []
  const modelOptions = model?.options ?? catalog.unknownModelOptions ?? []
  const modelValues = Object.fromEntries(
    modelOptions.flatMap((option) => {
      const explicitValue = values[option.id]
      if (explicitValue !== undefined) {
        if (
          !model &&
          option.kind.type === 'select' &&
          !option.kind.choices.some((choice) => choice.value === explicitValue)
        ) {
          return []
        }
        return [[option.id, explicitValue]]
      }
      return model && includeCatalogDefaults && !option.apply.inheritCliDefault
        ? [[option.id, option.kind.defaultValue]]
        : []
    })
  )
  const composedModelId =
    modelId && catalog.composeModelValue ? catalog.composeModelValue(modelId, modelValues) : modelId
  const modelOverridden =
    Boolean(modelId) && catalog.modelApply.agentArgsOverride?.(trailingAgentArgs) === true

  if (modelId && catalog.modelApply.launchArgs) {
    args.push(...catalog.modelApply.launchArgs(composedModelId!))
    if (!modelOverridden) {
      appliedValues.model = modelId
    }
  }
  for (const option of modelOptions) {
    const value = modelValues[option.id]
    if (value === undefined) {
      continue
    }
    if (option.apply.composedIntoModel) {
      if (catalog.modelApply.launchArgs && !modelOverridden) {
        appliedValues[option.id] = value
      }
      continue
    }
    if (
      !option.apply.launchArgs ||
      (!modelId && option.apply.agentArgsOverride?.(trailingAgentArgs))
    ) {
      continue
    }
    args.push(...option.apply.launchArgs(value))
    if (!modelOverridden && !option.apply.agentArgsOverride?.(trailingAgentArgs)) {
      appliedValues[option.id] = value
    }
  }
  if (values.openrouterCandidates !== undefined) {
    const candidates = openrouterCandidates.parse(JSON.parse(String(values.openrouterCandidates)))
    assertOpenRouterRoute({ agent, model: modelId ?? undefined, openrouterCandidates: candidates })
    if (modelOverridden) {
      throw new Error('Agent arguments cannot override a saved OpenRouter route.')
    }
    appliedValues.openrouterCandidates = JSON.stringify(candidates)
  }
  return { args, appliedValues }
}
