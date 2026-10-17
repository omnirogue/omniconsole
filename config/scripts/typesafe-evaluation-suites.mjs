import { RECIPE_EVALUATION_CASES } from './decision-recipe-corpus.mjs'
import { EVALUATION_CASES } from './typesafe-evaluation-corpus.mjs'
import { ADVERTISING_EVALUATION_CASES } from './typesafe-advertising-evaluation-corpus.mjs'
import { evaluateNumericAdvertisingReference } from './typesafe-advertising-numeric-reference.mjs'
import {
  PAIRWISE_EVALUATION_CASES,
  evaluatePairwiseNumericReference
} from './typesafe-advertising-pairwise-corpus.mjs'
import { summarizePairwiseExperiment } from './typesafe-advertising-pairwise-analysis.mjs'
import {
  ADSET_PROFITABILITY_CASES,
  evaluateAdsetProfitabilityReference
} from './typesafe-adset-profitability-corpus.mjs'
import { runProfitabilitySimulation } from './adset-profitability-simulation.mjs'

export function resolveEvaluationSuite(name = 'core') {
  if (name === 'decision_recipes') {
    return {
      id: name,
      cases: RECIPE_EVALUATION_CASES,
      baselineArm: 'existing_regex',
      baselineDescription:
        'No deployed baseline for these semantic recipes; Gemini is a measured comparator.',
      limitations: [
        'Six advisory recipes with four authored cases each; only two holdout cases per recipe.',
        'The Gemini comparator is not a measured end-to-end production workflow baseline.',
        'No real support outcomes, CSAT, advertising uplift or production throughput were measured.',
        'Batching compares identical independent questions, not serially dependent decisions.'
      ]
    }
  }
  if (name === 'core') {
    return {
      id: 'core',
      cases: EVALUATION_CASES,
      baselineArm: 'existing_regex',
      baselineDescription: 'production/classifyAgentTurnFailure',
      limitations: []
    }
  }
  if (name === 'advertising') {
    return {
      id: 'advertising',
      cases: ADVERTISING_EVALUATION_CASES,
      baselineArm: 'numeric_reference',
      baselineDescription:
        'synthetic-purchase-policy.v1; evaluation only, not the deployed optimizer',
      baseline: { arm: 'numeric_reference', evaluate: evaluateNumericAdvertisingReference },
      limitations: [
        'Per-ad recommendations are against a fictional predeclared policy, not proven profit outcomes.',
        'The numerical reference is experimental deterministic code, not the existing production advertising policy.',
        'Three synthetic sibling ads per selection case; complete groups are not collected from a live account.',
        'Text-only creative comparisons exclude image/video extraction costs and errors.',
        'No ad mutations, approvals, budgets, attribution connectors, or deployed prompts are changed.'
      ]
    }
  }
  if (name === 'advertising_pairwise') {
    return {
      id: name,
      cases: PAIRWISE_EVALUATION_CASES,
      baselineArm: 'numeric_reference',
      baselineDescription: 'Fictional matched-context pairwise policy; not a production optimizer',
      baseline: { arm: 'numeric_reference', evaluate: evaluatePairwiseNumericReference },
      summarize: summarizePairwiseExperiment,
      limitations: [
        'Twelve synthetic scenario families each have four related context/order variants, not 48 independent examples.',
        'Missing historical evidence may legitimately require abstention; richer-context labels differ only when justified by visible evidence.',
        'Stable selection after A/B reversal is measured by ad ID, not by the displayed slot.',
        'More supported decisions in synthetic context tests do not establish real advertising profit or causal uplift.',
        'No ad mutations, approvals, budgets, or deployed prompts are changed.'
      ]
    }
  }
  if (name === 'adset_profitability') {
    return {
      id: name,
      cases: ADSET_PROFITABILITY_CASES,
      baselineArm: 'numeric_reference',
      baselineDescription:
        'Fictional conditional-profitability study policy; not a production optimizer',
      baseline: { arm: 'numeric_reference', evaluate: evaluateAdsetProfitabilityReference },
      simulate: runProfitabilitySimulation,
      limitations: [
        'Forty-eight synthetic policy examples are sixteen families of three related variants, not 48 independent campaigns.',
        'Conditional statistical profitability estimates are computed in code, not invented by model confidence.',
        'Highest probability of positive contribution is not probability of being the best ad set or permission to act.',
        'The seeded campaign simulation assumes known contribution margins and click costs; its findings are not live-advertising calibration.',
        'Statistical claim reliability depends on maturity, measurement integrity, stationarity, prior and monitoring assumptions.',
        'Typesafe interpretation accuracy does not demonstrate predictive improvement over the numerical reference.',
        'No ad mutations, approvals, budgets, or deployed prompts are changed.'
      ]
    }
  }
  throw new TypeError('evaluation_invalid_suite')
}
