import type { DecisionRequest } from '../../shared/structured-decisions'
import type { DecisionTelemetry } from './decision-telemetry'
import type { DecisionMeasurementContext } from './decision-telemetry-measurement'

export const DECISION_MEASUREMENT_COUNTERS = [
  'admitted',
  'queued',
  'started',
  'completed',
  'cancelled',
  'dropped',
  'droppedInvalidRequest',
  'droppedDisposed',
  'droppedQueueFull',
  'droppedQueueCleared',
  'ringEvicted',
  'appendDropped',
  'appendFailed',
  'appendSucceeded'
] as const
export type DecisionMeasurementCounter = (typeof DECISION_MEASUREMENT_COUNTERS)[number]
export type DecisionMeasurementSnapshot = Record<DecisionMeasurementCounter, number>

/** Process-local totals; completed includes cancelled work, and append success is a sink acknowledgement, not proof of disk durability. */
export class DecisionMeasurementCounters {
  private readonly counts = Object.fromEntries(
    DECISION_MEASUREMENT_COUNTERS.map((name) => [name, 0])
  ) as DecisionMeasurementSnapshot

  count(name: DecisionMeasurementCounter, amount = 1): void {
    if (!Object.hasOwn(this.counts, name) || !Number.isSafeInteger(amount) || amount < 0) {
      return
    }
    this.counts[name] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[name] + amount)
  }

  snapshot(): DecisionMeasurementSnapshot {
    return { ...this.counts }
  }
}

export function countDroppedDecision(
  telemetry: { countMeasurement(name: DecisionMeasurementCounter, amount?: number): void },
  reason: 'droppedInvalidRequest' | 'droppedDisposed' | 'droppedQueueFull' | 'droppedQueueCleared',
  amount = 1
): void {
  telemetry.countMeasurement('dropped', amount)
  telemetry.countMeasurement(reason, amount)
}

export function recordClearedDecisionQueue(
  jobs: readonly {
    request: DecisionRequest
    options: { measurement?: DecisionMeasurementContext }
    started: number
  }[],
  telemetry: DecisionTelemetry,
  reason: 'disabled' | 'disposed'
): void {
  countDroppedDecision(telemetry, 'droppedQueueCleared', jobs.length)
  for (const job of jobs) {
    telemetry.record({
      timestamp: Date.now(),
      capability: job.request.capability,
      routineId: job.request.routineId,
      mode: 'shadow',
      status: 'dropped',
      reason,
      elapsedMs: Date.now() - job.started,
      attempts: 0,
      ...(job.options.measurement ? { measurement: job.options.measurement } : {})
    })
  }
}

export function recordDecisionQueueOverflow(
  request: DecisionRequest,
  measurement: DecisionMeasurementContext | undefined,
  telemetry: DecisionTelemetry
): void {
  countDroppedDecision(telemetry, 'droppedQueueFull')
  telemetry.record({
    timestamp: Date.now(),
    capability: request.capability,
    routineId: request.routineId,
    mode: 'shadow',
    status: 'dropped',
    reason: 'queue_full',
    elapsedMs: 0,
    attempts: 0,
    ...(measurement ? { measurement } : {})
  })
}
