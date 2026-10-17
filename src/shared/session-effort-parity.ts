/**
 * Requested vs applied reasoning effort (and model) for one launched agent: a native
 * chat session, a chain step, or an orchestration worker.
 *
 * Why this exists: effort is forwarded at launch (`--effort`,
 * `-c model_reasoning_effort=`) and mid-session (`/effort`), but the value the
 * provider actually runs with is only ever learned from what it reports back. The app
 * used to overwrite the requested value with the reported one everywhere except the
 * Codex resume relaunch, so a session, a chain step or a reviewer could silently run
 * at a lower effort than the person picked and nothing said so.
 *
 * The two values are therefore kept apart: `requested` is what we asked for,
 * `applied` is what the provider reported. A divergence is surfaced, never resolved
 * by rewriting the request. An effort the model does not advertise is `unsupported`
 * — an explicit refusal, never a quiet step down to the nearest lower level.
 *
 * Pure: no catalog, i18n or transport imports, so main, renderer and mobile share it.
 * Copy for these states lives with the surface that renders them.
 */

export type SessionEffortSelection = {
  model?: string
  effort?: string
}

export type SessionEffortParityState =
  /** Nothing was requested, or the provider has not reported yet. Not a claim. */
  | 'unobserved'
  /** The provider reported exactly what was requested. */
  | 'match'
  /** The provider reported something else — show both values. */
  | 'mismatch'
  /** The requested effort is not advertised for this model: refuse, do not clamp. */
  | 'unsupported'

/** Closed set, so a producer and its localized copy cannot drift. */
export type SessionEffortParityReason =
  | 'effort-differs'
  | 'model-differs'
  /** Requested an effort, the launch/provider carried none at all. */
  | 'effort-dropped'
  | 'effort-unsupported'

export type SessionEffortParity = {
  requested?: SessionEffortSelection
  applied?: SessionEffortSelection
  state: SessionEffortParityState
  reason?: SessionEffortParityReason
}

function normalizeValue(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeSelection(
  selection: SessionEffortSelection | null | undefined
): SessionEffortSelection | undefined {
  const model = normalizeValue(selection?.model)
  const effort = normalizeValue(selection?.effort)
  if (!model && !effort) {
    return undefined
  }
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

function parity(
  requested: SessionEffortSelection | undefined,
  applied: SessionEffortSelection | undefined,
  state: SessionEffortParityState,
  reason?: SessionEffortParityReason
): SessionEffortParity {
  return {
    ...(requested ? { requested } : {}),
    ...(applied ? { applied } : {}),
    state,
    ...(reason ? { reason } : {})
  }
}

/**
 * Compare what was asked for with what the provider reported.
 *
 * `supportedEfforts` is the model's advertised levels; omit it when unknown (an empty
 * or missing list is never read as "unsupported", because an absent probe is not
 * evidence). The unsupported check runs before the comparison so a refusal is
 * reported even when the provider has not answered yet.
 */
export function evaluateSessionEffortParity(args: {
  requested?: SessionEffortSelection | null
  applied?: SessionEffortSelection | null
  supportedEfforts?: readonly string[] | null
}): SessionEffortParity {
  const requested = normalizeSelection(args.requested)
  const applied = normalizeSelection(args.applied)
  // Why the key and not the values: passing an `applied` object at all is the caller
  // saying "this is what the launch/provider ended up with". An empty one means it
  // carried nothing — which is a dropped effort, not a missing observation.
  const observed = args.applied !== undefined && args.applied !== null
  const supported = args.supportedEfforts ?? null
  if (
    requested?.effort &&
    supported &&
    supported.length > 0 &&
    !supported.includes(requested.effort)
  ) {
    return parity(requested, applied, 'unsupported', 'effort-unsupported')
  }
  if (!requested || !observed) {
    return parity(requested, applied, 'unobserved')
  }
  if (requested.model && applied?.model && requested.model !== applied.model) {
    return parity(requested, applied, 'mismatch', 'model-differs')
  }
  if (requested.effort && !applied?.effort) {
    return parity(requested, applied, 'mismatch', 'effort-dropped')
  }
  if (requested.effort && applied?.effort && requested.effort !== applied.effort) {
    return parity(requested, applied, 'mismatch', 'effort-differs')
  }
  return parity(requested, applied, 'match')
}

/**
 * The pair a message about this divergence should name. A model divergence names the
 * models; anything else names the efforts, with no cross-fallback — naming a model as
 * the "applied effort" is how a dropped effort read like an applied one.
 */
export function sessionEffortParityValues(parityRecord: SessionEffortParity): {
  requested?: string
  applied?: string
} {
  if (parityRecord.reason === 'model-differs' || !parityRecord.requested?.effort) {
    return {
      ...(parityRecord.requested?.model ? { requested: parityRecord.requested.model } : {}),
      ...(parityRecord.applied?.model ? { applied: parityRecord.applied.model } : {})
    }
  }
  return {
    requested: parityRecord.requested.effort,
    ...(parityRecord.applied?.effort ? { applied: parityRecord.applied.effort } : {})
  }
}

/** A divergence the person has to see: a real mismatch or a refused effort. */
export function isSessionEffortParityDivergent(
  parityRecord: SessionEffortParity | null | undefined
): boolean {
  return parityRecord?.state === 'mismatch' || parityRecord?.state === 'unsupported'
}

/**
 * Whether a divergence must hold the composer's send. Blocking is the only way the
 * person finds out before the turn burns at the wrong effort; it lifts as soon as
 * they re-pick (making requested match again) or accept what the provider reported.
 *
 * It grants nothing: no extra workers, budget or authority follows from any effort.
 */
export function sessionEffortParityBlocksSend(
  parityRecord: SessionEffortParity | null | undefined,
  accepted = false
): boolean {
  return !accepted && isSessionEffortParityDivergent(parityRecord)
}

const PARITY_STATES: readonly SessionEffortParityState[] = [
  'unobserved',
  'match',
  'mismatch',
  'unsupported'
]

const PARITY_REASONS: readonly SessionEffortParityReason[] = [
  'effort-differs',
  'model-differs',
  'effort-dropped',
  'effort-unsupported'
]

function selectionFromUnknown(value: unknown): SessionEffortSelection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  return normalizeSelection({
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.effort === 'string' ? { effort: record.effort } : {})
  })
}

/** Read a parity record back from disk (chain steps persist one per step). */
export function normalizeSessionEffortParity(value: unknown): SessionEffortParity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const state = PARITY_STATES.find((candidate) => candidate === record.state)
  if (!state) {
    return null
  }
  const reason = PARITY_REASONS.find((candidate) => candidate === record.reason)
  return parity(
    selectionFromUnknown(record.requested),
    selectionFromUnknown(record.applied),
    state,
    reason
  )
}

/** Stable key for "this exact divergence", so accepting one does not accept the next. */
export function sessionEffortParityKey(parityRecord: SessionEffortParity): string {
  const selection = (value: SessionEffortSelection | undefined): string =>
    `${value?.model ?? ''}/${value?.effort ?? ''}`
  return [
    parityRecord.state,
    parityRecord.reason ?? '',
    selection(parityRecord.requested),
    selection(parityRecord.applied)
  ].join('|')
}
