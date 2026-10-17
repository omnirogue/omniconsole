import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId
} from './native-chat-session-option-snapshot'
import {
  acceptReportedSessionOption,
  applyNativeChatReportedSessionOptions,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type { AgentSessionOptionsResult } from './agent-session-wire'

function effortOption(model: AgentSessionOptionsResult['models'][number]): CatalogOption | null {
  if (model.efforts.length <= 1) {
    return null
  }
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: model.efforts,
      defaultValue: model.defaultEffort ?? model.efforts[0]!.value
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
  }
}

function discoveredModel(model: AgentSessionOptionsResult['models'][number]): CatalogModel {
  const effort = effortOption(model)
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    options: effort ? [effort] : []
  }
}

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map(discoveredModel)
  if (!models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}

export type StructuredAgentSessionOptionState = {
  catalog: AgentSessionOptionCatalog | null
  record: NativeChatSessionOptionRecord
  pendingId: string | null
}

export function createStructuredAgentSessionOptionState(
  agent = 'codex'
): StructuredAgentSessionOptionState {
  return { catalog: null, record: createNativeChatSessionOptionRecord(agent), pendingId: null }
}

export function applyStructuredAgentSessionOptions(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult
): StructuredAgentSessionOptionState {
  applyNativeChatReportedSessionOptions(
    state.record,
    {
      model: result.current.model,
      ...(result.current.effort ? { effort: result.current.effort } : {})
    },
    // Absent means the host confirmed nothing, not that it confirmed everything:
    // a host that predates `confirmed` only ever echoed back what it was sent.
    result.current.confirmed ?? []
  )
  return { ...state, catalog: structuredAgentSessionOptionCatalog(seed, result) }
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  return buildNativeChatSessionOptionSnapshot({
    catalog: state.catalog,
    models: state.catalog.models,
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
}

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue
): boolean {
  const descriptor = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
  return Boolean(
    state.catalog &&
    typeof value === 'string' &&
    state.pendingId === null &&
    descriptor?.kind.type === 'select' &&
    descriptor.kind.choices.some((choice) => choice.value === value)
  )
}

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  if (!state.catalog) {
    return state
  }
  const effectiveModel = resolveEffectiveNativeChatModelId(
    state.catalog,
    state.catalog.models,
    state.record
  )
  setTrackedSessionOption(state.record, id, value, 'dispatched', effectiveModel)
  return { ...state, pendingId: null }
}

/**
 * Commit one pick together with the values the agent session echoed back.
 *
 * Why the echo is not committed as the pick: `agentSession.setOption` answers with the
 * options the session ended up on, and a host that resolves `max` to `xhigh` (or falls
 * an unknown level back to a lower one) answers with the lower value. Recorded as the
 * request that would erase what the person asked for; folded as a report it stays
 * beside it and the surface can show both.
 */
export function commitStructuredAgentSessionOptionResult(
  state: StructuredAgentSessionOptionState,
  requested: { id: string; value: string },
  echoed?: Readonly<Record<string, string>> | null
): StructuredAgentSessionOptionState {
  const next = commitStructuredAgentSessionOption(state, requested.id, requested.value)
  const reported = echoed ?? {}
  if (Object.keys(reported).length === 0) {
    return next
  }
  const model =
    reported.model ??
    (next.catalog
      ? (resolveEffectiveNativeChatModelId(next.catalog, next.catalog.models, next.record) ??
        undefined)
      : undefined)
  if (!model) {
    return next
  }
  applyNativeChatReportedSessionOptions(next.record, { ...reported, model })
  return { ...next }
}

/** Keep the value the session reported and stop asking for the one it did not apply. */
export function acceptAppliedStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string
): StructuredAgentSessionOptionState {
  if (!state.catalog) {
    return state
  }
  const modelId = resolveEffectiveNativeChatModelId(
    state.catalog,
    state.catalog.models,
    state.record
  )
  return acceptReportedSessionOption(state.record, modelId, id) ? { ...state } : state
}

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: string
}

/**
 * The picks a mutation must remember so the next launch starts where the user left off.
 * Keyed off the same ids the launch seed reads back, so a pick this surface cannot
 * re-seed is never written.
 *
 * Model and effort travel as a pair: a launch resolves a stored effort only under a
 * stored model, so an effort-only pick adopts the model it was chosen against. Values
 * come from what the provider committed, not what was requested — it reconciles an
 * effort the newly selected model cannot run before reporting back.
 *
 * `state` may still be pre-commit: a changed model arrives in `committed`, and an
 * unchanged one is already what the record tracks, so neither reading depends on the
 * commit having landed.
 */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const committedModel = committed.model
  const modelId =
    typeof committedModel === 'string' && committedModel.trim()
      ? committedModel
      : resolveEffectiveNativeChatModelId(state.catalog, state.catalog.models, state.record)
  if (!modelId) {
    return []
  }
  return STRUCTURED_LAUNCH_SEED_OPTION_IDS.flatMap((optionId) => {
    const value = committed[optionId]
    return typeof value === 'string' && value.trim() ? [{ modelId, optionId, value }] : []
  })
}
