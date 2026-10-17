import type { AgentType } from './agent-status-types'
import type {
  CatalogMidSessionApply,
  AgentSessionOptionCatalog
} from './agent-session-option-catalog'
import type {
  ReportedSessionOptionValues,
  SessionOptionValue,
  SessionOptionValueSource
} from './native-chat-session-options'

export type TrackedNativeChatSessionOption = {
  value: SessionOptionValue
  source: Exclude<SessionOptionValueSource, 'unknown'>
  /**
   * What was asked for, kept only while the provider reported something else. Why not
   * overwritten: a report used to replace the request outright, so a session running
   * at another effort than the person picked looked like their own choice. Cleared by
   * a fresh request, or by accepting what the provider reported.
   */
  requested?: SessionOptionValue
}

export type NativeChatSessionOptionRecord = {
  agent: AgentType
  model?: TrackedNativeChatSessionOption
  valuesByModel: Record<string, Record<string, TrackedNativeChatSessionOption>>
}

export function createNativeChatSessionOptionRecord(
  agent: AgentType
): NativeChatSessionOptionRecord {
  return { agent, valuesByModel: {} }
}

export function cloneNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord
): NativeChatSessionOptionRecord {
  return {
    agent: record.agent,
    ...(record.model ? { model: { ...record.model } } : {}),
    valuesByModel: Object.fromEntries(
      Object.entries(record.valuesByModel).map(([modelId, values]) => [
        modelId,
        Object.fromEntries(Object.entries(values).map(([id, tracked]) => [id, { ...tracked }]))
      ])
    )
  }
}

export function isFlipOnlyMidSession(
  midSession: CatalogMidSessionApply | undefined
): midSession is Extract<CatalogMidSessionApply, { kind: 'toggle-command' }> {
  return midSession?.kind === 'toggle-command'
}

export function getTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): TrackedNativeChatSessionOption | undefined {
  return modelId ? record.valuesByModel[modelId]?.[optionId] : undefined
}

export function clearTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): void {
  if (!modelId) {
    return
  }
  const current = record.valuesByModel[modelId]
  if (!current || !(optionId in current)) {
    return
  }
  const next = { ...current }
  delete next[optionId]
  if (Object.keys(next).length === 0) {
    delete record.valuesByModel[modelId]
  } else {
    record.valuesByModel[modelId] = next
  }
}

export function clearNativeChatSessionModel(record: NativeChatSessionOptionRecord): void {
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  record.model = undefined
  if (modelId) {
    delete record.valuesByModel[modelId]
  }
}

export function setTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  optionId: string,
  value: SessionOptionValue,
  source: TrackedNativeChatSessionOption['source'],
  /** The model the picker drew this option under when none is tracked — without it a
   *  value set against a CLI default would be dispatched and then silently forgotten. */
  fallbackModelId: string | null = null
): string | null {
  if (optionId === 'model') {
    record.model = { value, source }
    return typeof value === 'string' ? value : null
  }
  const modelId =
    (typeof record.model?.value === 'string' ? record.model.value : null) ?? fallbackModelId
  if (!modelId) {
    return null
  }
  record.valuesByModel[modelId] = {
    ...record.valuesByModel[modelId],
    [optionId]: { value, source }
  }
  return modelId
}

export function flattenNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord,
  modelId: string
): Record<string, SessionOptionValue> {
  return {
    model: modelId,
    ...Object.fromEntries(
      Object.entries(record.valuesByModel[modelId] ?? {}).map(([id, tracked]) => [
        id,
        tracked.value
      ])
    )
  }
}

/** What this entry asked for: an explicit request, or the request a report is holding. */
export function requestedTrackedValue(
  tracked: TrackedNativeChatSessionOption | undefined
): SessionOptionValue | undefined {
  if (!tracked) {
    return undefined
  }
  return tracked.source === 'reported' ? tracked.requested : (tracked.requested ?? tracked.value)
}

/** A read-back value that remembers the request it replaced, and only while it differs.
 *  `source` is the provider's own provenance: a host that names an id in `confirmed`
 *  reported it, and one that does not merely echoed back what it was sent. */
function reportedTracked(
  value: SessionOptionValue,
  requested: SessionOptionValue | undefined,
  source: TrackedNativeChatSessionOption['source'] = 'reported'
): TrackedNativeChatSessionOption {
  return {
    value,
    source,
    ...(requested !== undefined && requested !== value ? { requested } : {})
  }
}

/**
 * Fold a provider frame into the record. The reported value becomes the displayed
 * truth, and any different request it replaced is kept beside it so the surface can
 * show requested vs applied instead of silently adopting the provider's answer.
 */
export function applyNativeChatReportedSessionOptions(
  record: NativeChatSessionOptionRecord,
  values: ReportedSessionOptionValues,
  /** Ids the provider reported back. Omitted means every value is a report, which
   *  is what a surface that only ever learns values by reading them sends. */
  confirmed?: readonly string[]
): boolean {
  const sourceFor = (id: string): TrackedNativeChatSessionOption['source'] =>
    confirmed === undefined || confirmed.includes(id) ? 'reported' : 'dispatched'
  const modelId = typeof values.model === 'string' ? values.model : null
  if (!modelId) {
    return false
  }
  const priorModelId = typeof record.model?.value === 'string' ? record.model.value : null
  const modelChanged = record.model?.value !== modelId
  let changed = modelChanged || record.model?.source !== sourceFor('model')
  const nextModel = reportedTracked(
    modelId,
    requestedTrackedValue(record.model),
    sourceFor('model')
  )
  changed = changed || record.model?.requested !== nextModel.requested
  record.model = nextModel
  // Why the prior model's values: a report that also moved the model still replaced
  // the effort the person asked for, and that request is what makes the swap visible.
  const requestSource =
    (modelChanged && priorModelId ? record.valuesByModel[priorModelId] : undefined) ??
    record.valuesByModel[modelId] ??
    {}
  const modelValues = modelChanged ? {} : { ...record.valuesByModel[modelId] }
  for (const [id, value] of Object.entries(values)) {
    if (id === 'model') {
      continue
    }
    const current = modelValues[id]
    if (value === null) {
      if (current && sourceFor(id) === 'reported') {
        delete modelValues[id]
        changed = true
      }
      continue
    }
    const next = reportedTracked(value, requestedTrackedValue(requestSource[id]), sourceFor(id))
    if (
      current?.value !== value ||
      current.source !== next.source ||
      current.requested !== next.requested
    ) {
      changed = true
    }
    modelValues[id] = next
  }
  record.valuesByModel[modelId] = modelValues
  return changed
}

/**
 * Keep what the provider reported and stop asking for the value it refused. Used by
 * the surface's explicit "keep this" action — never automatically, or a divergence
 * would disappear without anybody seeing it.
 */
export function acceptReportedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): boolean {
  if (optionId === 'model') {
    if (!record.model?.requested) {
      return false
    }
    const { requested: _accepted, ...kept } = record.model
    record.model = kept
    return true
  }
  const tracked = modelId ? record.valuesByModel[modelId]?.[optionId] : undefined
  if (!modelId || !tracked?.requested) {
    return false
  }
  const { requested: _accepted, ...kept } = tracked
  record.valuesByModel[modelId] = { ...record.valuesByModel[modelId], [optionId]: kept }
  return true
}

export function matchNativeChatCatalogModelId(
  catalog: AgentSessionOptionCatalog,
  reported: string
): string | null {
  const normalized = reported.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  const exact = catalog.models.find((model) => model.id.toLowerCase() === normalized)
  if (exact) {
    return exact.id
  }
  const byLabel = catalog.models.find((model) => model.label.toLowerCase() === normalized)
  if (byLabel) {
    return byLabel.id
  }
  const containing = [...catalog.models]
    .sort((left, right) => right.id.length - left.id.length)
    .find((model) => normalized.includes(model.id.toLowerCase()))
  return containing?.id ?? null
}
