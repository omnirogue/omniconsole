import type { SessionPrepRoutingReceipt } from './session-prep-types'
import { isTuiAgent } from './tui-agent-config'

/** Routing receipts describe a choice; they never grant authority or attest a served model. */
export function normalizeSessionRoutingReceipt(
  value: unknown
): SessionPrepRoutingReceipt | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (
    !['selected', 'shadow', 'off', 'unavailable', 'pinned'].includes(String(raw.status)) ||
    typeof raw.reason !== 'string'
  ) {
    return undefined
  }
  const result: SessionPrepRoutingReceipt = {
    status: raw.status as SessionPrepRoutingReceipt['status'],
    reason: raw.reason.slice(0, 4000)
  }
  if (typeof raw.tier === 'string') {
    result.tier = raw.tier.slice(0, 100)
  }
  if (typeof raw.version === 'string') {
    result.version = raw.version.slice(0, 200)
  }
  if (typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0) {
    result.elapsedMs = raw.elapsedMs
  }
  if (raw.modelEvidence === 'advertised' || raw.modelEvidence === 'estate-policy') {
    result.modelEvidence = raw.modelEvidence
  }
  if (raw.selected && typeof raw.selected === 'object') {
    const selected = raw.selected as Record<string, unknown>
    if (isTuiAgent(selected.provider) && typeof selected.model === 'string') {
      result.selected = { provider: selected.provider, model: selected.model.slice(0, 100) }
      if (typeof selected.effort === 'string') {
        result.selected.effort = selected.effort.slice(0, 100)
      }
    }
  }
  return result
}
