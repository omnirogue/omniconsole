import {
  decisionFailureCodeSchema,
  decisionIdentifierSchema,
  type DecisionFailureCode,
  type DecisionResult,
  type DecisionRequest
} from '../../shared/structured-decisions'
import {
  DecisionMeasurementCounters,
  type DecisionMeasurementCounter,
  type DecisionMeasurementSnapshot
} from './decision-measurement-counters'
import {
  boundedDecisionEntries,
  projectDecisionMeasuredChoice,
  sanitizeDecisionMeasurement,
  type DecisionMeasurementContext,
  type DecisionMeasuredChoice
} from './decision-telemetry-measurement'
export type { DecisionMeasurementContext } from './decision-telemetry-measurement'
export type {
  DecisionMeasurementCounter,
  DecisionMeasurementSnapshot
} from './decision-measurement-counters'

type DecisionTelemetryChoice = {
  value: string | number
  confidence?: number
  matches?: boolean
} & Partial<DecisionMeasuredChoice>

export type DecisionTelemetryEvent = {
  timestamp: number
  capability: string
  routineId?: string
  mode: 'live' | 'shadow'
  status: 'success' | 'disabled' | 'unavailable' | 'cancelled' | 'dropped'
  reason?: DecisionFailureCode
  provider?: string
  model?: string
  requestId?: string
  elapsedMs: number
  attempts: number
  usage?: DecisionResult['usage']
  choices?: Record<string, DecisionTelemetryChoice>
  measurement?: DecisionMeasurementContext
}
export type DecisionComparison = Record<string, string | number | boolean>
export type DecisionTelemetryOptions = {
  capacity?: number
  append?: (event: Readonly<DecisionTelemetryEvent>) => Promise<void>
}

export class DecisionTelemetry {
  private readonly measurement = new DecisionMeasurementCounters()
  private readonly ring: DecisionTelemetryEvent[] = []
  private readonly pending: DecisionTelemetryEvent[] = []
  private appending = false
  private readonly capacity: number
  constructor(private readonly options: DecisionTelemetryOptions = {}) {
    const capacity = options.capacity ?? 128
    this.capacity = Number.isFinite(capacity)
      ? Math.max(1, Math.min(512, Math.floor(capacity)))
      : 128
  }

  record(event: DecisionTelemetryEvent): void {
    const measurement = sanitizeDecisionMeasurement(event.measurement, event.capability)
    // Copy only approved metadata; callers cannot accidentally persist state or provider errors.
    const safe: DecisionTelemetryEvent = {
      timestamp: safeNumber(event.timestamp),
      capability: safeIdentifier(event.capability),
      mode: event.mode === 'live' ? 'live' : 'shadow',
      status: ['success', 'disabled', 'unavailable', 'cancelled', 'dropped'].includes(event.status)
        ? event.status
        : 'unavailable',
      elapsedMs: safeNumber(event.elapsedMs),
      attempts: Math.min(2, Math.floor(safeNumber(event.attempts))),
      ...(measurement ? { measurement } : {}),
      ...(event.routineId ? { routineId: safeIdentifier(event.routineId) } : {}),
      ...(event.reason && decisionFailureCodeSchema.safeParse(event.reason).success
        ? { reason: event.reason }
        : {}),
      ...(event.provider ? { provider: safeIdentifier(event.provider) } : {}),
      ...(event.model ? { model: safeIdentifier(event.model) } : {}),
      ...(event.requestId ? { requestId: safeIdentifier(event.requestId) } : {}),
      ...(event.usage
        ? {
            usage: {
              inputTokens: Math.floor(safeNumber(event.usage.inputTokens)),
              outputTokens: Math.floor(safeNumber(event.usage.outputTokens))
            }
          }
        : {})
    }
    if (event.choices) {
      const choices = boundedDecisionEntries(event.choices, 64)
      const measured =
        choices.complete &&
        choices.entries.length === 1 &&
        choices.entries[0]![0] === 'classification'
          ? projectDecisionMeasuredChoice(safe.capability, measurement, choices.entries[0]![1])
          : undefined
      safe.choices = Object.fromEntries(
        choices.entries
          .filter((entry): entry is [string, DecisionTelemetryChoice] =>
            Boolean(entry[1] && typeof entry[1] === 'object')
          )
          .map(([id, choice]) => [
            safeIdentifier(id),
            {
              value:
                typeof choice.value === 'string'
                  ? safeIdentifier(choice.value)
                  : safeNumber(choice.value),
              ...(typeof choice.confidence === 'number' &&
              Number.isFinite(choice.confidence) &&
              choice.confidence >= 0 &&
              choice.confidence <= 1
                ? { confidence: choice.confidence }
                : {}),
              ...(typeof choice.matches === 'boolean' ? { matches: choice.matches } : {}),
              ...(id === 'classification' && measured
                ? { ...measured, matches: choice.value === measured.baselineValue }
                : {})
            }
          ])
      )
    }
    this.ring.push(safe)
    if (this.ring.length > this.capacity) {
      this.ring.shift()
      this.countMeasurement('ringEvicted')
    }
    if (this.options.append && this.pending.length < this.capacity) {
      this.pending.push(structuredClone(safe))
      void this.flush()
    } else if (this.options.append) {
      this.countMeasurement('appendDropped')
    }
  }

  snapshot(): DecisionTelemetryEvent[] {
    return structuredClone(this.ring)
  }

  countMeasurement(name: DecisionMeasurementCounter, amount = 1): void {
    this.measurement.count(name, amount)
  }

  measurementSnapshot(): DecisionMeasurementSnapshot {
    return this.measurement.snapshot()
  }

  private async flush(): Promise<void> {
    if (this.appending) {
      return
    }
    this.appending = true
    try {
      while (this.pending.length > 0) {
        const event = this.pending.shift()!
        try {
          await this.options.append?.(event)
          this.countMeasurement('appendSucceeded')
        } catch {
          this.countMeasurement('appendFailed')
        }
      }
    } finally {
      this.appending = false
    }
  }
}

function safeIdentifier(value: string): string {
  return decisionIdentifierSchema.safeParse(value).success ? value : 'redacted'
}
function safeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function decisionChoices(
  result: DecisionResult,
  request: DecisionRequest,
  comparison?: DecisionComparison,
  measurement?: DecisionMeasurementContext
): DecisionTelemetryEvent['choices'] {
  return Object.fromEntries(
    Object.entries(result.answers).map(([id, answer]) => {
      const value =
        answer.type === 'choice'
          ? answer.choice
          : answer.type === 'score'
            ? answer.score
            : answer.noul
      const expected = comparison && Object.hasOwn(comparison, id) ? comparison[id] : undefined
      const comparable =
        typeof expected === 'number' ||
        (typeof expected === 'string' && request.questions[id]?.type === 'choice')
      const questions = boundedDecisionEntries(request.questions, 1)
      const question = request.questions[id]
      const measured =
        id === 'classification' &&
        questions.complete &&
        questions.entries.length === 1 &&
        question?.type === 'choice' &&
        answer.type === 'choice'
          ? projectDecisionMeasuredChoice(
              request.capability,
              measurement,
              { value, baselineValue: expected, probabilities: answer.probabilities },
              question.criteria
            )
          : undefined
      return [
        id,
        {
          value,
          ...('confidence' in answer ? { confidence: answer.confidence } : {}),
          ...(comparable ? { matches: value === expected } : {}),
          ...measured
        }
      ]
    })
  )
}
