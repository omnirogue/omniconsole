import { validOpenRouterRoute } from './openrouter-route'
import type { AgentLaunchPreferences } from './agent-session-host-authority'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import type { TuiAgent } from './tui-agent'

/** The actor half a person picks for a launch: which model, at which effort. */
export type AgentLaunchPreferenceSelection = {
  model?: string
  openrouterCandidates?: string[]
  effort?: string
}

export type AgentLaunchPreferenceCheck =
  | { ok: true; preferences: AgentLaunchPreferences | undefined }
  | { ok: false; code: 'invalid_argument'; message: string }

function invalid(message: string): AgentLaunchPreferenceCheck {
  return { ok: false, code: 'invalid_argument', message }
}

/**
 * One validation for every launch that carries a model or effort — worker starts,
 * chained sessions and continuations alike. Why shared: the worker RPC already
 * refuses a flag its catalog cannot apply; a sidebar launch that skipped the same
 * check would start the CLI with a foreign flag and fail after the tab exists.
 */
export function checkAgentLaunchPreferences(
  agent: TuiAgent,
  selection: AgentLaunchPreferenceSelection | null | undefined
): AgentLaunchPreferenceCheck {
  if (!validOpenRouterRoute({ agent, ...selection })) {
    return invalid('Invalid ordered OpenRouter route.')
  }
  const model = selection?.model?.trim() || undefined
  const effort = selection?.effort?.trim() || undefined
  if (effort && !model && !['claude', 'codex'].includes(agent)) {
    return invalid('--effort requires --model.')
  }
  if (!model && !effort) {
    return { ok: true, preferences: undefined }
  }

  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog?.supportsWorkerLaunchPreferences || !catalog.modelApply.launchArgs) {
    return invalid(`Agent ${agent} does not support launch-time model selection.`)
  }

  if (effort) {
    const catalogModel = model ? findCatalogModel(catalog, model) : undefined
    const option =
      findCatalogOption(catalogModel, 'effort') ??
      (!catalogModel
        ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
        : undefined)
    if (
      option?.kind.type !== 'select' ||
      !option.kind.choices.some((choice) => choice.value === effort)
    ) {
      return invalid(`Agent ${agent} model ${model} does not support effort ${effort}.`)
    }
  }

  const requested: AgentLaunchPreferences = {
    ...(selection?.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...selection.openrouterCandidates] }
      : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
  const resolved = resolveAgentSessionOptionLaunch(
    agent,
    launchPreferencesToSessionOptions(requested),
    [],
    false
  )
  if (resolved.appliedValues.model !== model || resolved.appliedValues.effort !== effort) {
    return invalid(`Agent ${agent} cannot apply the requested worker launch preferences.`)
  }
  return { ok: true, preferences: requested }
}

/** Launch-time session option values for a validated selection; empty when nothing was picked. */
export function launchPreferencesToSessionOptions(
  preferences: AgentLaunchPreferences | undefined
): Record<string, string> | undefined {
  if (!preferences?.model && !preferences?.effort) {
    return undefined
  }
  return {
    ...(preferences.model ? { model: preferences.model } : {}),
    ...(preferences.openrouterCandidates !== undefined
      ? {
          openrouterCandidates: JSON.stringify(preferences.openrouterCandidates)
        }
      : {}),
    ...(preferences.effort ? { effort: preferences.effort } : {})
  }
}
