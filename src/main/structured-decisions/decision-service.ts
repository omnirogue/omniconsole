import {
  DECISION_MAX_TIMEOUT_MS,
  DecisionProviderError,
  snapshotDecisionRequest,
  validateDecisionResult,
  type DecisionFailureCode,
  type DecisionOutcome,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import { decisionEnvironmentKilled, type DecisionConfiguration } from './decision-configuration'
import {
  abortableDecisionWork as abortable,
  decisionAbortError as abortError,
  waitForDecisionRetry
} from './decision-cancellation'
import {
  decisionFailureStatus,
  requireDecisionMode,
  type DecisionPolicySources
} from './decision-policy'
import {
  DecisionTelemetry,
  decisionChoices,
  type DecisionComparison,
  type DecisionMeasurementContext
} from './decision-telemetry'
import { sanitizeDecisionMeasurement } from './decision-telemetry-measurement'
import { notifyDecisionObserver } from './decision-observation'
import { serviceJevCall } from './jev-call-rows'
import {
  countDroppedDecision,
  recordClearedDecisionQueue,
  recordDecisionQueueOverflow
} from './decision-measurement-counters'

export type DecisionServiceOptions = {
  provider: StructuredDecisionProvider
  telemetry?: DecisionTelemetry
  shadowQueueLimit?: number
  shadowConcurrency?: number
  onEvaluated?: (request: DecisionRequest, result: DecisionResult) => void
} & DecisionPolicySources
export type DecisionEvaluationOptions = {
  signal?: AbortSignal
}
export type DecisionShadowOptions = {
  comparison?: DecisionComparison
  measurement?: DecisionMeasurementContext
} & DecisionEvaluationOptions
type ShadowJob = {
  request: DecisionRequest
  options: DecisionShadowOptions
  started: number
}
const TRANSIENT_FAILURES = new Set<DecisionFailureCode>([
  'network',
  'rate_limited',
  'overloaded',
  'provider_error',
  'timeout'
])

function errorCode(error: unknown): DecisionFailureCode {
  return error instanceof DecisionProviderError ? error.code : 'provider_error'
}
function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback
}
export class DecisionService {
  readonly telemetry: DecisionTelemetry
  private readonly queue: ShadowJob[] = []
  private readonly controllers = new Set<AbortController>()
  private active = 0
  private disposed = false
  private readonly queueLimit: number
  private readonly concurrency: number

  constructor(private readonly options: DecisionServiceOptions) {
    this.telemetry = options.telemetry ?? new DecisionTelemetry()
    this.queueLimit = boundedInteger(options.shadowQueueLimit, 8, 32)
    this.concurrency = boundedInteger(options.shadowConcurrency, 2, 4)
  }

  async evaluate(
    request: DecisionRequest,
    options: DecisionEvaluationOptions = {}
  ): Promise<DecisionOutcome> {
    this.telemetry.countMeasurement('admitted')
    const started = Date.now()
    let startedRun = false
    try {
      const snapshot = snapshotDecisionRequest(request)
      startedRun = true
      const result = await this.run(snapshot, 'live', options, started)
      return { status: 'evaluated', mode: 'live', result }
    } catch (error) {
      if (!startedRun) {
        countDroppedDecision(this.telemetry, 'droppedInvalidRequest')
      }
      const reason = errorCode(error)
      return { status: decisionFailureStatus(reason), reason }
    }
  }

  observeShadow(request: DecisionRequest, options: DecisionShadowOptions = {}): void {
    this.telemetry.countMeasurement('admitted')
    if (this.disposed) {
      countDroppedDecision(this.telemetry, 'droppedDisposed')
      return
    }
    try {
      const snapshot = snapshotDecisionRequest(request)
      const measurement = sanitizeDecisionMeasurement(options.measurement, snapshot.capability)
      if (this.queue.length >= this.queueLimit) {
        recordDecisionQueueOverflow(snapshot, measurement, this.telemetry)
        return
      }
      const comparison = options.comparison
        ? Object.fromEntries(
            Object.keys(snapshot.questions)
              .filter((id) => Object.hasOwn(options.comparison!, id))
              .map((id) => [id, options.comparison![id]])
          )
        : undefined
      this.queue.push({
        request: snapshot,
        options: { signal: options.signal, comparison, ...(measurement ? { measurement } : {}) },
        started: Date.now()
      })
      this.telemetry.countMeasurement('queued')
      queueMicrotask(() => this.drain())
    } catch {
      countDroppedDecision(this.telemetry, 'droppedInvalidRequest')
    }
  }

  dispose(): void {
    this.disposed = true
    recordClearedDecisionQueue(this.queue.splice(0), this.telemetry, 'disposed')
    for (const controller of this.controllers) {
      controller.abort(new DecisionProviderError('disposed'))
    }
  }

  abortPending(): void {
    recordClearedDecisionQueue(this.queue.splice(0), this.telemetry, 'disabled')
    for (const controller of this.controllers) {
      controller.abort(new DecisionProviderError('disabled'))
    }
  }

  private drain(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active++
      void this.run(job.request, 'shadow', job.options, job.started)
        .catch(() => undefined)
        .finally(() => {
          this.active--
          this.drain()
        })
    }
  }

  private async gate(
    request: DecisionRequest,
    mode: 'live' | 'shadow'
  ): Promise<DecisionConfiguration> {
    if (this.disposed) {
      throw new DecisionProviderError('disposed')
    }
    return requireDecisionMode(request, mode, this.options)
  }

  private async run(
    request: DecisionRequest,
    mode: 'live' | 'shadow',
    options: DecisionShadowOptions,
    started: number
  ): Promise<DecisionResult> {
    this.telemetry.countMeasurement('started')
    const controller = new AbortController()
    const signal = controller.signal
    this.controllers.add(controller)
    const abortFromCaller = (): void => controller.abort(new DecisionProviderError('cancelled'))
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (options.signal?.aborted) {
      abortFromCaller()
    }
    let deadline = started + DECISION_MAX_TIMEOUT_MS
    let timeout = setTimeout(
      () => controller.abort(new DecisionProviderError('timeout')),
      Math.max(0, deadline - Date.now())
    )
    let checking = false
    const monitor = setInterval(() => {
      if (decisionEnvironmentKilled(this.options.environment?.() ?? process.env)) {
        controller.abort(new DecisionProviderError('disabled'))
        return
      }
      if (checking || signal.aborted) {
        return
      }
      checking = true
      void this.gate(request, mode)
        .catch((error: unknown) => controller.abort(new DecisionProviderError(errorCode(error))))
        .finally(() => {
          checking = false
        })
    }, 250)
    let attempts = 0
    try {
      const config = await abortable(this.gate(request, mode), signal)
      deadline = Math.min(deadline, started + config.timeoutMs)
      clearTimeout(timeout)
      if (deadline <= Date.now()) {
        throw new DecisionProviderError('timeout')
      }
      timeout = setTimeout(
        () => controller.abort(new DecisionProviderError('timeout')),
        deadline - Date.now()
      )
      const input = Object.freeze({ ...request, model: request.model ?? config.model })
      const call = serviceJevCall(input.capability, config.timeoutMs)
      let result: DecisionResult | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) {
          throw abortError(signal)
        }
        await abortable(this.gate(request, mode), signal)
        if (signal.aborted) {
          throw abortError(signal)
        }
        attempts++
        try {
          const evaluated = this.options.provider.evaluate(input, { signal, call })
          result = validateDecisionResult(await abortable(evaluated, signal), input)
          break
        } catch (error) {
          if (signal.aborted) {
            throw abortError(signal)
          }
          const delay = error instanceof DecisionProviderError ? (error.retryAfterMs ?? 150) : 0
          if (
            !(error instanceof DecisionProviderError) ||
            !error.retryable ||
            !TRANSIENT_FAILURES.has(error.code) ||
            attempt === 1 ||
            delay >= deadline - Date.now()
          ) {
            throw error
          }
          await waitForDecisionRetry(delay, signal)
        }
      }
      if (!result) {
        throw new DecisionProviderError('provider_error')
      }
      await abortable(this.gate(request, mode), signal)
      if (signal.aborted || Date.now() >= deadline) {
        throw signal.aborted ? abortError(signal) : new DecisionProviderError('timeout')
      }
      this.telemetry.record({
        timestamp: Date.now(),
        capability: request.capability,
        routineId: request.routineId,
        mode,
        status: 'success',
        provider: result.provider,
        model: result.model,
        requestId: result.requestId,
        usage: result.usage,
        elapsedMs: Date.now() - started,
        attempts,
        choices: decisionChoices(result, request, options.comparison, options.measurement),
        ...(options.measurement ? { measurement: options.measurement } : {})
      })
      notifyDecisionObserver(this.options.onEvaluated, request, result)
      return result
    } catch (error) {
      const reason = signal.aborted ? errorCode(abortError(signal)) : errorCode(error)
      if (reason === 'cancelled' || (signal.aborted && reason !== 'timeout')) {
        this.telemetry.countMeasurement('cancelled')
      }
      this.telemetry.record({
        timestamp: Date.now(),
        capability: request.capability,
        routineId: request.routineId,
        mode,
        status: decisionFailureStatus(reason),
        reason,
        elapsedMs: Date.now() - started,
        attempts,
        ...(options.measurement ? { measurement: options.measurement } : {})
      })
      throw new DecisionProviderError(reason)
    } finally {
      this.telemetry.countMeasurement('completed')
      clearInterval(monitor)
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
      this.controllers.delete(controller)
    }
  }
}
