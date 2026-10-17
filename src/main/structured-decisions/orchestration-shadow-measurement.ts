import { createHash } from 'node:crypto'
import type { DecisionMeasurementContext } from './decision-telemetry'
import type { OrchestrationShadowObservation } from './orchestration-shadow'

const COUNTERS = [
  'outcomeChangesSeen',
  'toolEventsSeen',
  'uninstalledCalls',
  'missingBaselineChanges',
  'queueFullCalls',
  'observerQueueFullDropped',
  'filteredToolEvents',
  'projectionFailures',
  'projectedObservations',
  'perChangeLimitDropped',
  'invalidProjectionDropped',
  'observerDeliveriesQueued',
  'observerDeliveriesStarted',
  'observerDeliveriesSuppressed',
  'observerDeliveriesFailed',
  'sourceArraysSampled',
  'sourceEntriesInspected',
  'sourceEntriesOmitted',
  'sourceArraysTruncated',
  'ambiguousBaselineSkipped',
  'oversizedIdentitySkipped'
] as const
type Counter = (typeof COUNTERS)[number]
const counters = Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<Counter, number>
export const ORCHESTRATION_SHADOW_PROJECTION_VERSION = 'orchestration-structural-v2' as const

/** Process-local stage counters, not a census of unique lifecycle decisions. */
export function countOrchestrationShadow(name: Counter, amount = 1): void {
  if (Object.hasOwn(counters, name) && Number.isFinite(amount) && amount > 0) {
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + Math.floor(amount))
  }
}

export function orchestrationShadowMeasurementSnapshot() {
  return { scope: 'process_since_start' as const, counters: { ...counters } }
}

export function orchestrationShadowReference(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function orchestrationShadowMeasurement(
  observation: OrchestrationShadowObservation,
  eventReference: string
): Readonly<DecisionMeasurementContext> {
  const { kind, facts } = observation
  const baselineSource =
    kind === 'routing'
      ? 'recorded_route'
      : kind === 'handoff'
        ? 'handoff_projection'
        : kind === 'done_when'
          ? 'recorded_outcome_status'
          : kind === 'tool_action'
            ? 'tool_name_classifier'
            : kind === 'error_classification'
              ? facts.source === 'attempt'
                ? 'recorded_attempt_failure'
                : 'recorded_outcome_block'
              : 'recorded_verdict'
  return Object.freeze({
    eventReference,
    // Only the new bounded count/flag projection participates, never raw source objects or text.
    eventFingerprint: orchestrationShadowReference(
      JSON.stringify([ORCHESTRATION_SHADOW_PROJECTION_VERSION, kind, eventReference, facts])
    ),
    baselineSource,
    evidenceScope: 'structural_metadata',
    projectionVersion: ORCHESTRATION_SHADOW_PROJECTION_VERSION
  })
}
