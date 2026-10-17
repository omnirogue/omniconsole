import { DecisionProviderError, type DecisionResult } from '../../shared/structured-decisions'
import type { DecisionExperimentFixture } from './decision-experiment-fixtures'

export const DECISION_EXPERIMENT_SUITE = 'known-answer-v1'
export const DECISION_EXPERIMENT_TARIFF = Object.freeze({
  provider: 'typesafe',
  model: 'jev-1.13.0',
  inputUsdPerMillion: 0.042,
  outputUsdPerMillion: 0,
  source: 'https://docs.typesafe.ai/models',
  checkedOn: '2026-09-20'
})
export const DECISION_EXPERIMENT_GATING = Object.freeze({
  choiceConfidence: 0.7,
  scoreConfidence: 0.7,
  noulDistanceFromHalf: 0.3
})

// The caller attests these are actual observations of this exact fixture, with all three questions.
export type DecisionExperimentBaseline = {
  suite: typeof DECISION_EXPERIMENT_SUITE
  fixtureId: string
  fixtureFingerprint: string
  measured: true
  model: string
  latencyMs: number
  costUsd: number | null
}
export type DecisionExperimentMetrics = {
  observations: {
    intent: { choice: string; confidence: number; probabilities: Record<string, number> }
    completeness: { score: number; confidence: number; probabilities: Record<string, number> }
    requestsChange: { probability: number }
  }
  disagreements: { intent: boolean; completeness: boolean; requestsChange: boolean; count: number }
  lowConfidence: { choice: boolean; score: boolean; noul: boolean }
  gate: 'defer' | 'observed'
  brier: { choice: number; score: number; noul: number }
  scoreAbsoluteError: number
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
export function matchDecisionExperimentBaseline(
  fixture: DecisionExperimentFixture,
  baselines: readonly DecisionExperimentBaseline[]
) {
  const matches = baselines.filter(
    (entry) => entry.suite === DECISION_EXPERIMENT_SUITE && entry.fixtureId === fixture.id
  )
  const entry = matches.length === 1 ? matches[0] : undefined
  if (
    !entry ||
    entry.fixtureFingerprint !== fixture.fingerprint ||
    entry.measured !== true ||
    !/^[a-zA-Z0-9_.:-]{1,96}$/.test(entry.model) ||
    !finiteNonnegative(entry.latencyMs) ||
    (entry.costUsd !== null && !finiteNonnegative(entry.costUsd))
  ) {
    return null
  }
  return { model: entry.model, latencyMs: entry.latencyMs, costUsd: entry.costUsd }
}
/** Brier score of a choice or score distribution against the expected key (0 is perfect, 2 worst). */
export function decisionDistributionBrier(
  probabilities: Record<string, number>,
  expected: string
): number {
  return Object.entries(probabilities).reduce(
    (sum, [key, probability]) => sum + (probability - Number(key === expected)) ** 2,
    0
  )
}

/** Brier score of one yes-probability against the truth (0 is perfect, 1 worst). */
export function decisionNoulBrier(probability: number, expected: boolean): number {
  return (probability - Number(expected)) ** 2
}
export function decisionExperimentMetrics(
  result: DecisionResult,
  fixture: DecisionExperimentFixture
): DecisionExperimentMetrics {
  const { intent, completeness, requestsChange } = result.answers
  if (intent.type !== 'choice' || completeness.type !== 'score' || requestsChange.type !== 'noul') {
    throw new DecisionProviderError('invalid_response')
  }
  const scoreAbsoluteError = Math.abs(completeness.score - fixture.expected.completeness)
  const disagreements = {
    intent: intent.choice !== fixture.expected.intent,
    completeness: scoreAbsoluteError > 0.5,
    requestsChange: requestsChange.noul >= 0.5 !== fixture.expected.requestsChange
  }
  const lowConfidence = {
    choice: intent.confidence < DECISION_EXPERIMENT_GATING.choiceConfidence,
    score: completeness.confidence < DECISION_EXPERIMENT_GATING.scoreConfidence,
    noul: Math.abs(requestsChange.noul - 0.5) < DECISION_EXPERIMENT_GATING.noulDistanceFromHalf
  }
  return {
    observations: {
      intent: {
        choice: intent.choice,
        confidence: intent.confidence,
        probabilities: { ...intent.probabilities }
      },
      completeness: {
        score: completeness.score,
        confidence: completeness.confidence,
        probabilities: { ...completeness.probabilities }
      },
      requestsChange: { probability: requestsChange.noul }
    },
    disagreements: { ...disagreements, count: Object.values(disagreements).filter(Boolean).length },
    lowConfidence,
    gate: Object.values(lowConfidence).some(Boolean) ? 'defer' : 'observed',
    scoreAbsoluteError,
    brier: {
      choice: decisionDistributionBrier(intent.probabilities, fixture.expected.intent),
      score: decisionDistributionBrier(
        completeness.probabilities,
        String(fixture.expected.completeness)
      ),
      noul: decisionNoulBrier(requestsChange.noul, fixture.expected.requestsChange)
    }
  }
}
