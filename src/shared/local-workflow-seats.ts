import type { CatalogModel } from './agent-session-option-catalog'
import { effortChoicesFor } from './build-review-model-options'
import { localWorkflowProviderLabel } from './local-workflow-model-label'
import type { ModelLineage } from './model-lineage'
import type { LocalWorkflowSeatCapacity } from './local-workflow-seat-capacity'

/**
 * Gemini is answer/find-only: it never ranks, verifies, chairs or ranks findings. OpenRouter and
 * Ollama have no default model: a seat names one (an API id, or an installed tag).
 */
export type LocalWorkflowRoute = 'claude' | 'codex' | 'grok' | 'gemini' | 'openrouter' | 'ollama'

/** Routes whose seats must name their model: the catalog has no default to fall back on. */
export function localWorkflowRouteNamesModel(route: LocalWorkflowRoute): boolean {
  return route === 'openrouter' || route === 'ollama'
}
export type LocalWorkflowSeatChoice = {
  id: string
  agent: LocalWorkflowRoute
  accountId: string
  model?: string
  effort?: string
}

/** Public projection of host-attested route/model/account evidence; never credentials. */
export type LocalWorkflowSeatCatalog = {
  agent: LocalWorkflowRoute
  accountId: string
  accountLabel: string
  /** Host-selected CLI config directory; path only, never credentials. */
  accountHome: string
  unavailableReason?: string
  /**
   * Set when only streamed launches cannot run (Grok's real binary or its signed-in login is
   * missing). Working agents, frozen calls and follow-ups start the CLI on PATH and ignore it.
   */
  streamUnavailableReason?: string
  /** Claude and Codex accounts: their usage as last verified (local-workflow-seat-capacity.ts). */
  capacity?: LocalWorkflowSeatCapacity
  policyRevision: string
  /**
   * Earlier revisions of this same route and account that completed runs may carry. A follow-up
   * only needs the same account, so it accepts these too; workflow launches never do.
   */
  priorPolicyRevisions?: string[]
  models: {
    catalog: CatalogModel
    resolvedModelId: string
    supportsTools?: boolean
    lineage: ModelLineage
  }[]
}

export type ResolvedLocalWorkflowSeat = {
  id: string
  agent: LocalWorkflowRoute
  accountId: string
  model: string
  effort: string | null
  lineage: ModelLineage
  policyRevision: string
}

/**
 * Whether a draft's calls use a route's streamed launch: every current Council call answers in
 * text, and every workspace read streams. Working agents and frozen Discover calls do not.
 */
export function localWorkflowDraftStreams(
  preset: 'council' | 'discover',
  draft: { capability?: string; access?: string }
): boolean {
  return draft.capability !== 'working-agent' && (preset === 'council' || draft.access !== 'frozen')
}

/** The catalog as a streaming draft sees it: a route that cannot stream is unavailable there. */
export function streamedLocalWorkflowCatalog(
  catalog: readonly LocalWorkflowSeatCatalog[]
): LocalWorkflowSeatCatalog[] {
  return catalog.map((entry) =>
    entry.streamUnavailableReason && !entry.unavailableReason
      ? { ...entry, unavailableReason: entry.streamUnavailableReason }
      : entry
  )
}

/** Renderer may preview this check; only the host's own fresh catalog authorizes Start. */
export function resolveLocalWorkflowSeat(
  choice: LocalWorkflowSeatChoice,
  catalog: readonly LocalWorkflowSeatCatalog[]
): ResolvedLocalWorkflowSeat {
  if (!choice.id.trim() || !choice.accountId.trim()) {
    throw new Error('Choose a workflow seat and account.')
  }
  // Seat ids are internal; people see the provider name.
  const name = localWorkflowProviderLabel(choice.agent)
  const matches = catalog.filter(
    (entry) => entry.agent === choice.agent && entry.accountId === choice.accountId
  )
  if (matches.length !== 1) {
    throw new Error(`${name}: the selected account is unavailable or ambiguous.`)
  }
  const entry = matches[0]
  if (entry.unavailableReason) {
    throw new Error(`${name}: ${entry.unavailableReason}`)
  }
  if (!entry.policyRevision.trim()) {
    throw new Error(`${name}: workflow route verification is missing.`)
  }
  if (localWorkflowRouteNamesModel(choice.agent) && !choice.model) {
    throw new Error(`${name}: choose a model explicitly.`)
  }
  const modelMatches = entry.models.filter((model) =>
    choice.model ? model.catalog.id === choice.model : model.catalog.isDefault
  )
  if (modelMatches.length !== 1) {
    throw new Error(`${name}: choose an available model with a verified identity.`)
  }
  const model = modelMatches[0]
  if (!model.resolvedModelId.trim() || model.lineage === 'unknown') {
    throw new Error(`${name}: the selected model's family or exact identity is unverified.`)
  }
  const efforts = effortChoicesFor(choice.agent, [model.catalog], model.catalog.id)
  const option = model.catalog.options.find((candidate) => candidate.id === 'effort')
  const defaultEffort = option?.kind.type === 'select' ? option.kind.defaultValue : undefined
  const effort = choice.effort ?? (efforts.length ? defaultEffort : undefined)
  if ((efforts.length && !effort) || (effort && !efforts.some((item) => item.value === effort))) {
    throw new Error(`${name}: choose an effort supported by the selected model.`)
  }
  return {
    id: choice.id,
    agent: choice.agent,
    accountId: choice.accountId,
    model: model.resolvedModelId,
    effort: effort ?? null,
    lineage: model.lineage,
    policyRevision: entry.policyRevision
  }
}
