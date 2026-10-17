import {
  DECISION_MAX_TIMEOUT_MS,
  type DecisionFailureCode,
  type DecisionResult
} from '../../shared/structured-decisions'
import {
  DECISION_EXPERIMENT_GATING,
  DECISION_EXPERIMENT_SUITE,
  DECISION_EXPERIMENT_TARIFF,
  type DecisionExperimentMetrics
} from './decision-experiment-metrics'

export const DECISION_EXPERIMENT_MAX_REQUESTS = 6
export const DECISION_EXPERIMENT_MAX_MS = DECISION_EXPERIMENT_MAX_REQUESTS * DECISION_MAX_TIMEOUT_MS
export type DecisionExperimentSample = {
  fixtureId: string
  fixtureFingerprint: string
  status: 'evaluated' | 'unavailable'
  reason: DecisionFailureCode | null
  model: string | null
  latencyMs: number
  usage: DecisionResult['usage'] | null
  estimatedCostUsd: number | null
  metrics: DecisionExperimentMetrics | null
  baseline: { model: string; latencyMs: number; costUsd: number | null } | null
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}
export function decisionExperimentReport(
  samples: DecisionExperimentSample[],
  status: 'not_run' | 'completed' | 'stopped',
  reason: DecisionFailureCode | null
) {
  const evaluated = samples.filter((sample) => sample.status === 'evaluated')
  const paired = evaluated.filter((sample) => sample.baseline !== null)
  const priced = samples.filter((sample) => sample.estimatedCostUsd !== null)
  const costPairs = paired.filter(
    (sample) => sample.estimatedCostUsd !== null && sample.baseline!.costUsd !== null
  )
  const unreportedUsageRequests = samples.filter((sample) => sample.usage === null).length
  const knownIncrementalCostUsd = priced.reduce((sum, sample) => sum + sample.estimatedCostUsd!, 0)
  return {
    suite: DECISION_EXPERIMENT_SUITE,
    status,
    reason,
    automaticPromotion: false as const,
    limits: {
      maxRequests: DECISION_EXPERIMENT_MAX_REQUESTS,
      concurrency: 1,
      maxCallMs: DECISION_MAX_TIMEOUT_MS,
      maxExperimentMs: DECISION_EXPERIMENT_MAX_MS,
      retries: 0
    },
    tariff: DECISION_EXPERIMENT_TARIFF,
    gating: {
      ...DECISION_EXPERIMENT_GATING,
      calibrated: false,
      experimentalOnly: true,
      scoreDisagreementAbsoluteErrorAbove: 0.5,
      noulDecisionThreshold: 0.5
    },
    samples,
    totals: {
      requests: samples.length,
      evaluated: evaluated.length,
      usage: samples.reduce(
        (sum, sample) => ({
          inputTokens: sum.inputTokens + (sample.usage?.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (sample.usage?.outputTokens ?? 0)
        }),
        { inputTokens: 0, outputTokens: 0 }
      ),
      unreportedUsageRequests,
      knownIncrementalCostUsd,
      totalIncrementalCostUsd: priced.length === samples.length ? knownIncrementalCostUsd : null,
      costCoverage: priced.length === samples.length ? ('complete' as const) : ('partial' as const),
      meanLatencyMs: average(evaluated.map((sample) => sample.latencyMs)),
      disagreements: evaluated.reduce(
        (sum, sample) => sum + sample.metrics!.disagreements.count,
        0
      ),
      deferred: evaluated.filter((sample) => sample.metrics!.gate === 'defer').length
    },
    calibration: {
      status: 'insufficient_sample' as const,
      representativeSample: false as const,
      sampleCountPerPrimitive: evaluated.length,
      confidenceIsCorrectnessProbability: false as const,
      brierDefinition:
        'choice/score: sum of squared class errors; noul: squared yes-probability error',
      meanBrier: {
        choice: average(evaluated.map((sample) => sample.metrics!.brier.choice)),
        score: average(evaluated.map((sample) => sample.metrics!.brier.score)),
        noul: average(evaluated.map((sample) => sample.metrics!.brier.noul))
      }
    },
    comparison: {
      matchedPairs: paired.length,
      matchedCostPairs: costPairs.length,
      meanCandidateMinusBaselineLatencyMs: average(
        paired.map((sample) => sample.latencyMs - sample.baseline!.latencyMs)
      ),
      meanCandidateMinusBaselineCostUsd: average(
        costPairs.map((sample) => sample.estimatedCostUsd! - sample.baseline!.costUsd!)
      ),
      speedupEstablished: false as const,
      savingsEstablished: false as const,
      interpretation:
        'Descriptive fixture observations only; shadow calls add incremental cost, and failed calls may have unreported usage.'
    }
  }
}
export type DecisionExperimentReport = ReturnType<typeof decisionExperimentReport>
