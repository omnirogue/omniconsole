import { SESSION_ATTEMPT_FAILURE_CODES } from '../../shared/session-attempt-recovery'
import { mayBeRoundedMaximum, roundedSumIsOne } from '../../shared/structured-decision-results'

export type DecisionMeasurementContext = {
  eventReference: string
  eventFingerprint: string
  baselineSource:
    | 'recorded_verdict'
    | 'recorded_route'
    | 'handoff_projection'
    | 'recorded_outcome_status'
    | 'tool_name_classifier'
    | 'recorded_attempt_failure'
    | 'recorded_outcome_block'
  evidenceScope: 'structural_metadata'
  projectionVersion: 'orchestration-structural-v2'
}
export type DecisionMeasuredChoice = {
  baselineValue: string
  probabilities: Record<string, number>
}

const CAPABILITY_SOURCES: Record<string, readonly DecisionMeasurementContext['baselineSource'][]> =
  {
    'orchestration.judge': ['recorded_verdict'],
    'orchestration.review': ['recorded_verdict'],
    'orchestration.adversarial_review': ['recorded_verdict'],
    'orchestration.verify': ['recorded_verdict'],
    'orchestration.routing': ['recorded_route'],
    'orchestration.handoff': ['handoff_projection'],
    'orchestration.done_when': ['recorded_outcome_status'],
    'orchestration.tool_action': ['tool_name_classifier'],
    'orchestration.error_classification': ['recorded_attempt_failure', 'recorded_outcome_block']
  }
const CATEGORIES: Record<DecisionMeasurementContext['baselineSource'], readonly string[]> = {
  recorded_verdict: ['pass', 'findings', 'fail', 'insufficient_evidence', 'crashed'],
  recorded_route: ['same-session', 'native', 'task', 'worker', 'unknown'],
  handoff_projection: ['delivered', 'failed', 'sending', 'pending', 'unknown'],
  recorded_outcome_status: ['satisfied', 'pending', 'running', 'blocked', 'unknown'],
  tool_name_classifier: ['read', 'write', 'execute', 'ask', 'unknown'],
  recorded_attempt_failure: SESSION_ATTEMPT_FAILURE_CODES,
  recorded_outcome_block: ['recovering', 'waiting', 'attention', 'failed', 'unknown']
}

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/** Bound enumeration before copying; never evaluate getters on diagnostic input. */
export function boundedDecisionEntries(
  value: unknown,
  limit: number
): { entries: [string, unknown][]; complete: boolean } {
  const entries: [string, unknown][] = []
  const cap = Number.isSafeInteger(limit) ? Math.max(0, Math.min(255, limit)) : 0
  let examined = 0
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { entries, complete: false }
    }
    for (const key in value) {
      if (examined++ >= cap) {
        return { entries, complete: false }
      }
      if (!Object.hasOwn(value, key)) {
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        return { entries, complete: false }
      }
      entries.push([key, descriptor.value])
    }
    return { entries, complete: true }
  } catch {
    return { entries: [], complete: false }
  }
}

export function sanitizeDecisionMeasurement(
  value: unknown,
  capability: string
): DecisionMeasurementContext | undefined {
  try {
    const eventReference = ownData(value, 'eventReference')
    const eventFingerprint = ownData(value, 'eventFingerprint')
    const baselineSource = ownData(value, 'baselineSource')
    if (
      typeof eventReference !== 'string' ||
      eventReference.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(eventReference) ||
      typeof eventFingerprint !== 'string' ||
      eventFingerprint.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(eventFingerprint) ||
      typeof baselineSource !== 'string' ||
      baselineSource.length > 32 ||
      !Object.hasOwn(CATEGORIES, baselineSource) ||
      typeof capability !== 'string' ||
      capability.length > 96 ||
      !Object.hasOwn(CAPABILITY_SOURCES, capability) ||
      !CAPABILITY_SOURCES[capability]!.includes(
        baselineSource as DecisionMeasurementContext['baselineSource']
      ) ||
      ownData(value, 'evidenceScope') !== 'structural_metadata' ||
      ownData(value, 'projectionVersion') !== 'orchestration-structural-v2'
    ) {
      return undefined
    }
    return Object.freeze({
      eventReference,
      eventFingerprint,
      baselineSource: baselineSource as DecisionMeasurementContext['baselineSource'],
      evidenceScope: 'structural_metadata',
      projectionVersion: 'orchestration-structural-v2'
    })
  } catch {
    return undefined
  }
}

export function projectDecisionMeasuredChoice(
  capability: string,
  measurement: unknown,
  choice: unknown,
  criteria?: unknown
): DecisionMeasuredChoice | undefined {
  try {
    const context = sanitizeDecisionMeasurement(measurement, capability)
    if (!context) {
      return undefined
    }
    const labels = CATEGORIES[context.baselineSource]
    const value = ownData(choice, 'value'),
      baselineValue = ownData(choice, 'baselineValue')
    if (
      typeof value !== 'string' ||
      typeof baselineValue !== 'string' ||
      !labels.includes(value) ||
      !labels.includes(baselineValue)
    ) {
      return undefined
    }
    const distribution = boundedDecisionEntries(ownData(choice, 'probabilities'), 255)
    if (!distribution.complete || distribution.entries.length < 2) {
      return undefined
    }
    const probabilities: Record<string, number> = {}
    let sum = 0
    for (const [label, probability] of distribution.entries) {
      if (
        !labels.includes(label) ||
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      ) {
        return undefined
      }
      probabilities[label] = probability
      sum += probability
    }
    if (
      !roundedSumIsOne(sum, distribution.entries.length) ||
      !Object.hasOwn(probabilities, value) ||
      !Object.hasOwn(probabilities, baselineValue) ||
      !mayBeRoundedMaximum(probabilities, value)
    ) {
      return undefined
    }
    if (criteria !== undefined) {
      const declared = boundedDecisionEntries(criteria, 255)
      if (
        !declared.complete ||
        declared.entries.length !== distribution.entries.length ||
        declared.entries.some(([label]) => !Object.hasOwn(probabilities, label))
      ) {
        return undefined
      }
    }
    return { baselineValue, probabilities }
  } catch {
    return undefined
  }
}
