import type { AgentType } from './agent-status-types'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog
} from './agent-session-option-catalog'

/**
 * The effort levels a model advertises, read from the existing option catalog — the
 * same data the pickers and `checkAgentLaunchPreferences` already use. No new probe.
 *
 * Returns null when nothing advertises a level set (unknown agent, or a model whose
 * catalog entry has no effort option). Null means "unknown", never "unsupported":
 * a missing list must not be turned into a refusal.
 */
export function supportedEffortsForCatalogModel(
  catalog: AgentSessionOptionCatalog | null | undefined,
  modelId: string | null | undefined
): string[] | null {
  if (!catalog) {
    return null
  }
  const model = modelId ? findCatalogModel(catalog, modelId) : undefined
  const option =
    findCatalogOption(model, 'effort') ??
    // Why: an opaque id absent from the seed still has launch-safe levels.
    (model ? undefined : catalog.unknownModelOptions?.find((entry) => entry.id === 'effort'))
  if (option?.kind.type !== 'select') {
    return null
  }
  return option.kind.choices.map((choice) => choice.value)
}

/** Same, addressed by agent id, for launch paths that hold no catalog reference. An id
 *  no catalog knows simply has no advertised levels — never a refusal. */
export function supportedEffortsForAgentModel(
  agent: string,
  modelId: string | null | undefined
): string[] | null {
  return supportedEffortsForCatalogModel(getAgentSessionOptionCatalog(agent as AgentType), modelId)
}
