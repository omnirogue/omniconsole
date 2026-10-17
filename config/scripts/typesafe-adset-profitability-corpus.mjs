import { performance } from 'node:perf_hooks'
import { evaluateAdsetProfitability } from './adset-profitability-statistics.mjs'
import {
  ADSET_KEYS,
  ADSET_PROFITABILITY_POLICY,
  ADSET_PROFITABILITY_QUESTIONS,
  createAdsetProfitabilityState
} from './typesafe-adset-profitability-fixtures.mjs'
import { ADSET_PROFITABILITY_SCENARIOS } from './typesafe-adset-profitability-scenarios.mjs'

export { ADSET_PROFITABILITY_POLICY } from './typesafe-adset-profitability-fixtures.mjs'

export const ADSET_PROFITABILITY_CASES = Object.freeze(
  ADSET_PROFITABILITY_SCENARIOS.map((row) =>
    Object.freeze({
      id: `adset-${row.split}-${row.family}-${row.index}`,
      familyId: `adset-${row.family}`,
      split: row.split,
      origin: 'authored_synthetic',
      task: 'adset_profitability_selection',
      state: createAdsetProfitabilityState(row.observations, row.options),
      questions: ADSET_PROFITABILITY_QUESTIONS,
      expected: Object.freeze({
        winner: Object.freeze({ value: row.winner }),
        readiness: Object.freeze({ value: row.readiness })
      }),
      rationale: row.rationale
    })
  )
)

export function numericAdsetProfitabilityDecision(state) {
  const abstain = { winner: 'INSUFFICIENT_EVIDENCE', readiness: 'OBSERVE' }
  if (
    state?.simulationPolicy?.version !== ADSET_PROFITABILITY_POLICY.version ||
    !Array.isArray(state.adsets) ||
    state.adsets.length !== 3 ||
    new Set(state.adsets.map(({ key }) => key)).size !== 3 ||
    state.adsets.some(({ key }) => !ADSET_KEYS.includes(key)) ||
    ADSET_PROFITABILITY_POLICY.requiredGuards.some(
      (key) => state.campaign?.guards?.[key] !== true
    ) ||
    state.adsets.some(
      ({ source }) =>
        source?.campaignAdsets !== 3 ||
        source.familyAlpha !== ADSET_PROFITABILITY_POLICY.familyAlpha ||
        source.posteriorThreshold !== ADSET_PROFITABILITY_POLICY.posteriorThreshold ||
        source.maxEvidenceAgeSeconds !== ADSET_PROFITABILITY_POLICY.maxEvidenceAgeSeconds
    )
  ) {
    return abstain
  }
  const results = state.adsets.map(({ key, source }) => ({
    key,
    result: evaluateAdsetProfitability(source)
  }))
  if (
    results.some(
      ({ result }) => !result.evidenceReady || !Number.isFinite(result.posteriorProfitProbability)
    )
  ) {
    return abstain
  }
  const highest = Math.max(...results.map(({ result }) => result.posteriorProfitProbability))
  const candidates = results.filter(
    ({ result }) =>
      highest - result.posteriorProfitProbability <=
      ADSET_PROFITABILITY_POLICY.probabilityTieTolerance
  )
  if (candidates.length !== 1) {
    return { winner: 'TIE', readiness: 'OBSERVE' }
  }
  const winner = candidates[0]
  const ready =
    winner.result.posteriorProfitProbability >= ADSET_PROFITABILITY_POLICY.posteriorThreshold &&
    winner.result.anytime?.decision === 'PROFITABLE'
  return { winner: winner.key, readiness: ready ? 'READY_FOR_HUMAN_REVIEW' : 'OBSERVE' }
}

export function evaluateAdsetProfitabilityReference(request) {
  const started = performance.now()
  if (request?.capability !== 'evaluation_adset_profitability_selection') {
    return { status: 'skipped', errorCode: 'not_applicable', elapsedMs: 0 }
  }
  try {
    if (
      Object.keys(request.questions ?? {})
        .sort()
        .join(',') !== 'readiness,winner'
    ) {
      throw new Error('invalid_questions')
    }
    const values = numericAdsetProfitabilityDecision(request.state)
    return {
      status: 'success',
      elapsedMs: performance.now() - started,
      answers: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
      usage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0
    }
  } catch {
    return { status: 'error', errorCode: 'invalid_request', elapsedMs: performance.now() - started }
  }
}
