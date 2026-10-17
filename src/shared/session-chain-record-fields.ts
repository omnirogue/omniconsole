import {
  normalizePromptQueueEntry,
  PROMPT_QUEUE_MAX_ENTRIES,
  type PromptQueueEntry
} from './prompt-queue-types'
import type {
  SessionChainPlanVersion,
  SessionChainRound,
  SessionChainStepEnabledBy,
  SessionChainStepRoute,
  SessionChainStageShape,
  SessionChainStepSeat,
  SessionChainStepStage,
  SessionChainStepVerdict,
  SessionChainStepWait,
  SessionChainStepWaitReason,
  SessionChainStepWrites,
  SessionChainVerdictReceipt
} from './session-chain-types'

/**
 * Reading one field of a persisted chain record. The chain normalizer is an allow-list that rebuilds
 * every step, so a value it cannot read is DELETED on the next save: these readers are what decides,
 * field by field, whether this build understands a record or must refuse it whole.
 */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeSessionChainRound(value: unknown): SessionChainRound | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const key = optionalString(record.key)
  const index = record.index
  const total = record.total
  if (
    !key ||
    typeof index !== 'number' ||
    typeof total !== 'number' ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    total < index
  ) {
    return undefined
  }
  return { key, index, total }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key))
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isMoment(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function readIdList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => Boolean(optionalString(entry)))
    ? value.map((entry) => entry as string)
    : undefined
}

export function readPlanVersion(value: unknown): number | undefined {
  return isCount(value) ? value : undefined
}

export function readPlanVersions(value: unknown): SessionChainPlanVersion[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const entries = value.map((entry) => {
    const record = asRecord(entry)
    if (!record || !onlyKeys(record, ['version', 'supersedes', 'reason', 'at'])) {
      return undefined
    }
    const reason = record.reason === undefined ? undefined : optionalString(record.reason)
    return isCount(record.version) &&
      (record.supersedes === undefined || isCount(record.supersedes)) &&
      (record.reason === undefined || reason) &&
      isMoment(record.at)
      ? {
          version: record.version,
          ...(record.supersedes !== undefined ? { supersedes: record.supersedes as number } : {}),
          ...(reason ? { reason } : {}),
          at: record.at
        }
      : undefined
  })
  return entries.every((entry): entry is SessionChainPlanVersion => Boolean(entry))
    ? entries
    : undefined
}

export function readSeat(value: unknown): SessionChainStepSeat | undefined {
  const record = asRecord(value)
  return record &&
    onlyKeys(record, ['index', 'total']) &&
    isCount(record.index) &&
    isCount(record.total) &&
    record.total >= record.index
    ? { index: record.index, total: record.total }
    : undefined
}

const VERDICT_KINDS: readonly SessionChainStepVerdict['kind'][] = [
  'review',
  'judge',
  'verify',
  'critique'
]
const VERDICT_CONSUMPTIONS: readonly SessionChainStepVerdict['consumed'][] = [
  'select-winner',
  'gate',
  'record'
]

export function readStepVerdict(value: unknown): SessionChainStepVerdict | undefined {
  const record = asRecord(value)
  const over = record ? readIdList(record.over) : undefined
  return record &&
    onlyKeys(record, ['kind', 'over', 'consumed']) &&
    VERDICT_KINDS.includes(record.kind as SessionChainStepVerdict['kind']) &&
    over &&
    VERDICT_CONSUMPTIONS.includes(record.consumed as SessionChainStepVerdict['consumed'])
    ? {
        kind: record.kind as SessionChainStepVerdict['kind'],
        over,
        consumed: record.consumed as SessionChainStepVerdict['consumed']
      }
    : undefined
}

export function readEnabledBy(value: unknown): SessionChainStepEnabledBy | undefined {
  const record = asRecord(value)
  const verdict = record ? optionalString(record.verdict) : undefined
  const seatsOf = record ? optionalString(record.seatsOf) : undefined
  return record && onlyKeys(record, ['verdict', 'seatsOf']) && verdict && seatsOf
    ? { verdict, seatsOf }
    : undefined
}

export const STEP_WAIT_REASONS: readonly SessionChainStepWaitReason[] = [
  'capacity',
  'dependency',
  'human_decision'
]

const STAGE_SHAPES: readonly SessionChainStageShape[] = [
  'solo',
  'parallel',
  'council',
  'best-of',
  'custom'
]

/** The composer stage a seat belongs to; refused whole rather than read in part. */
export function readStepStage(value: unknown): SessionChainStepStage | undefined {
  const record = asRecord(value)
  if (!record || !onlyKeys(record, ['id', 'shape', 'width'])) {
    return undefined
  }
  const id = optionalString(record.id)
  const width = record.width
  if (
    !id ||
    !STAGE_SHAPES.includes(record.shape as SessionChainStageShape) ||
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > 64
  ) {
    return undefined
  }
  return { id, shape: record.shape as SessionChainStageShape, width }
}

/**
 * Prompts queued into one stage. An entry this build cannot read is DROPPED and the rest
 * are kept — the same rule the prompt queue uses for one unreadable row — but a `prompts`
 * value that is not a list at all refuses the field, so nothing silently becomes empty.
 */
export function readStepPrompts(value: unknown): PromptQueueEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .map(normalizePromptQueueEntry)
    .filter((entry): entry is PromptQueueEntry => entry !== null)
    .slice(0, PROMPT_QUEUE_MAX_ENTRIES)
}

export function readWait(value: unknown): SessionChainStepWait | undefined {
  const record = asRecord(value)
  if (!record || !onlyKeys(record, ['reason', 'since', 'ref'])) {
    return undefined
  }
  const ref = optionalString(record.ref)
  // A `ref` that is present but unreadable loses which blocker the wait named, so refuse the field.
  if (
    !STEP_WAIT_REASONS.includes(record.reason as SessionChainStepWaitReason) ||
    !isMoment(record.since) ||
    (record.ref !== undefined && !ref)
  ) {
    return undefined
  }
  return {
    reason: record.reason as SessionChainStepWaitReason,
    since: record.since,
    ...(ref ? { ref } : {})
  }
}

export const STEP_ROUTES: readonly SessionChainStepRoute[] = [
  'new-session',
  'human',
  'same-session'
]
export const STEP_WRITES: readonly SessionChainStepWrites[] = ['own-output-dir', 'workspace']

export function readVerdictReceipt(value: unknown): SessionChainVerdictReceipt | undefined {
  const record = asRecord(value)
  if (
    !record ||
    !onlyKeys(record, ['stepId', 'attemptId', 'verdict', 'consumptionKey', 'consumedAt', 'skipped'])
  ) {
    return undefined
  }
  const stepId = optionalString(record.stepId)
  const attemptId = optionalString(record.attemptId)
  const consumptionKey = optionalString(record.consumptionKey)
  if (
    !stepId ||
    !attemptId ||
    !consumptionKey ||
    record.verdict === undefined ||
    !isMoment(record.consumedAt) ||
    (record.skipped !== undefined && record.skipped !== true)
  ) {
    return undefined
  }
  return {
    stepId,
    attemptId,
    verdict: record.verdict,
    consumptionKey,
    consumedAt: record.consumedAt,
    ...(record.skipped === true ? { skipped: true as const } : {})
  }
}

/** Reads one optional field, recording a problem when the value is there but unreadable. */
export function readStepField<T>(
  problems: string[],
  stepId: string,
  field: string,
  raw: unknown,
  read: (value: unknown) => T | undefined
): T | undefined {
  if (raw === undefined) {
    return undefined
  }
  const value = read(raw)
  if (value === undefined) {
    problems.push(`step ${stepId}: this build cannot read ${field}`)
  }
  return value
}
