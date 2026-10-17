import {
  DECISION_MAX_TIMEOUT_MS,
  DecisionProviderError,
  decisionFailureCodeSchema,
  validateDecisionResult,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import {
  decisionExperimentFixtures,
  type DecisionExperimentFixture
} from './decision-experiment-fixtures'
import {
  decisionExperimentMetrics,
  matchDecisionExperimentBaseline,
  DECISION_EXPERIMENT_TARIFF,
  type DecisionExperimentBaseline
} from './decision-experiment-metrics'
import {
  decisionExperimentReport as report,
  DECISION_EXPERIMENT_MAX_REQUESTS,
  DECISION_EXPERIMENT_MAX_MS,
  type DecisionExperimentReport,
  type DecisionExperimentSample
} from './decision-experiment-report'
export {
  DECISION_EXPERIMENT_SUITE,
  DECISION_EXPERIMENT_TARIFF,
  type DecisionExperimentBaseline
} from './decision-experiment-metrics'
export {
  DECISION_EXPERIMENT_MAX_REQUESTS,
  type DecisionExperimentReport,
  type DecisionExperimentSample
} from './decision-experiment-report'
export type DecisionExperimentOptions = {
  provider: StructuredDecisionProvider
  enabled?: boolean
  execute?: boolean
  maxRequests?: number
  timeoutMs?: number
  signal?: AbortSignal
  baselines?: readonly DecisionExperimentBaseline[]
}
async function evaluateFixture(
  provider: StructuredDecisionProvider,
  fixture: DecisionExperimentFixture,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<DecisionResult> {
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  const cancel = (): void =>
    controller.abort(
      callerSignal?.reason instanceof DecisionProviderError
        ? callerSignal.reason
        : new DecisionProviderError('cancelled')
    )
  callerSignal?.addEventListener('abort', cancel, { once: true })
  if (callerSignal?.aborted) {
    cancel()
  }
  const timeout = setTimeout(
    () => controller.abort(new DecisionProviderError('timeout')),
    timeoutMs
  )
  let onAbort: () => void = () => undefined
  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      return provider.evaluate(fixture.request, { signal: controller.signal })
    })
    const result = validateDecisionResult(await Promise.race([work, aborted]), fixture.request)
    if (performance.now() >= deadline) {
      controller.abort(new DecisionProviderError('timeout'))
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason
    }
    if (result.provider !== provider.id || result.model !== fixture.request.model) {
      throw new DecisionProviderError('invalid_response')
    }
    return result
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

async function runFixtures(
  options: DecisionExperimentOptions,
  maxRequests: number,
  timeoutMs: number,
  signal: AbortSignal
): Promise<DecisionExperimentReport> {
  const samples: DecisionExperimentSample[] = []
  for (const fixture of decisionExperimentFixtures.slice(
    0,
    Math.min(maxRequests, DECISION_EXPERIMENT_MAX_REQUESTS)
  )) {
    if (signal.aborted) {
      return report(samples, 'stopped', signal.reason.code)
    }
    const started = performance.now()
    const sample: DecisionExperimentSample = {
      fixtureId: fixture.id,
      fixtureFingerprint: fixture.fingerprint,
      status: 'unavailable',
      reason: null,
      model: null,
      latencyMs: 0,
      usage: null,
      estimatedCostUsd: null,
      metrics: null,
      baseline: matchDecisionExperimentBaseline(fixture, options.baselines ?? [])
    }
    try {
      const result = await evaluateFixture(
        options.provider,
        fixture,
        Math.min(timeoutMs, DECISION_MAX_TIMEOUT_MS),
        signal
      )
      sample.metrics = decisionExperimentMetrics(result, fixture)
      sample.status = 'evaluated'
      sample.model = result.model
      sample.usage = result.usage
      sample.estimatedCostUsd =
        result.provider === DECISION_EXPERIMENT_TARIFF.provider
          ? (result.usage.inputTokens * DECISION_EXPERIMENT_TARIFF.inputUsdPerMillion) / 1_000_000
          : null
    } catch (error) {
      const parsed =
        error instanceof DecisionProviderError
          ? decisionFailureCodeSchema.safeParse(error.code)
          : null
      sample.reason = parsed?.success ? parsed.data : 'provider_error'
    }
    sample.latencyMs = Math.max(0, performance.now() - started)
    samples.push(sample)
    // Stop after an abort so an uncooperative provider cannot overlap the next fixture.
    if (sample.reason === 'timeout' || sample.reason === 'cancelled') {
      return report(samples, 'stopped', sample.reason)
    }
  }
  return report(samples, 'completed', null)
}

export async function runDecisionExperiment(
  options: DecisionExperimentOptions
): Promise<DecisionExperimentReport> {
  if (options.enabled !== true || options.execute !== true) {
    return report([], 'not_run', 'disabled')
  }
  const maxRequests = options.maxRequests ?? DECISION_EXPERIMENT_MAX_REQUESTS
  const timeoutMs = options.timeoutMs ?? DECISION_MAX_TIMEOUT_MS
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    return report([], 'not_run', 'invalid_configuration')
  }
  const controller = new AbortController()
  const cancel = (): void => controller.abort(new DecisionProviderError('cancelled'))
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) {
    cancel()
  }
  const timeout = setTimeout(
    () => controller.abort(new DecisionProviderError('timeout')),
    DECISION_EXPERIMENT_MAX_MS
  )
  try {
    return await runFixtures(options, maxRequests, timeoutMs, controller.signal)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}
