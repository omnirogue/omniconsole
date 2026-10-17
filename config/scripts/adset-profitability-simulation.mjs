import { evaluateAdsetProfitability } from './adset-profitability-statistics.mjs'

export const PROFITABILITY_CHECKPOINTS = Object.freeze([25, 50, 100, 200, 400, 800])
export const PROFITABILITY_SCENARIOS = Object.freeze(
  [
    { id: 'clear_winner', rates: [0.15, 0.025, 0.01], assumptionsHold: true },
    { id: 'weak_winner', rates: [0.065, 0.025, 0.01], assumptionsHold: true },
    { id: 'all_unprofitable', rates: [0.025, 0.015, 0.005], assumptionsHold: true },
    { id: 'near_break_even', rates: [0.05, 0.048, 0.052], assumptionsHold: true },
    {
      id: 'conditioned_early_luck',
      rates: [0.02, 0.025, 0.03],
      assumptionsHold: false,
      forcedEarlySuccesses: 5
    },
    {
      id: 'delayed_conversions',
      rates: [0.15, 0.025, 0.01],
      assumptionsHold: true,
      maturityLagClicks: 50
    },
    { id: 'unflagged_drift', rates: [0.01, 0.06, 0.02], assumptionsHold: false, drift: true },
    {
      id: 'known_drift_abstains',
      rates: [0.01, 0.06, 0.02],
      assumptionsHold: false,
      drift: true,
      knownDrift: true
    }
  ].map((scenario) => Object.freeze({ ...scenario, rates: Object.freeze(scenario.rates) }))
)

const ARMS = Object.freeze([
  'observed_cpa_roas_min50',
  'bayes_uniform_95',
  'bayes_uniform_99',
  'bayes_optimistic_95',
  'bayes_optimistic_99',
  'anytime_hoeffding_95',
  'anytime_exact_binomial_95'
])
const COST_PER_CLICK = 2
const NET_CONTRIBUTION = 40
const BREAK_EVEN = COST_PER_CLICK / NET_CONTRIBUTION

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function randomGenerator(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let word = state
    word = Math.imul(word ^ (word >>> 15), word | 1)
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61)
    return ((word ^ (word >>> 14)) >>> 0) / 4294967296
  }
}

function cumulativePurchases(scenario, adset, random) {
  const totals = [0]
  for (let click = 1; click <= PROFITABILITY_CHECKPOINTS.at(-1); click += 1) {
    const rate = scenario.drift && adset === 0 && click <= 100 ? 0.18 : scenario.rates[adset]
    let purchased = random() < rate
    if (scenario.forcedEarlySuccesses && adset === 0 && click <= 25) {
      purchased = click <= scenario.forcedEarlySuccesses
    }
    totals.push(totals.at(-1) + Number(purchased))
  }
  return totals
}

function summarizeNumbers(values) {
  if (!values.length) {
    return { count: 0, mean: null, median: null, p90: null }
  }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1]
  }
}

function emptyMetrics() {
  return {
    profitClaims: 0,
    falseProfitClaims: 0,
    unprofitableClaims: 0,
    falseUnprofitableClaims: 0,
    missedProfitableAdsets: 0,
    abstainedAdsets: 0,
    campaignsWithAnyProfitClaim: 0,
    campaignsWithFalseProfitClaim: 0,
    firstSelectedProfitable: 0,
    firstSelectedTrueBest: 0,
    firstProfitMaturedClicks: [],
    firstProfitDeliveredClicks: [],
    firstProfitCampaignSpend: []
  }
}

function emptyCalibration() {
  return Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    probabilitySum: 0,
    profitableTruth: 0
  }))
}

function monteCarloWilsonInterval(successes, total) {
  const squaredZ = 1.959963984540054 ** 2
  const rate = successes / total
  const denominator = 1 + squaredZ / total
  const center = (rate + squaredZ / (2 * total)) / denominator
  const radius =
    Math.sqrt(squaredZ * ((rate * (1 - rate)) / total + squaredZ / (4 * total ** 2))) / denominator
  return {
    level: 0.95,
    lower: Math.max(0, center - radius),
    upper: Math.min(1, center + radius),
    method: 'wilson-monte-carlo-only'
  }
}

function updateCalibration(bins, probability, profitable) {
  if (probability === null) {
    return
  }
  const bin = bins[Math.min(9, Math.floor(probability * 10))]
  bin.count += 1
  bin.probabilitySum += probability
  bin.profitableTruth += Number(profitable)
}

function calibrationReport(bins) {
  return bins.map(({ probabilitySum, ...bin }) => ({
    ...bin,
    meanPredictedProbability: bin.count ? probabilitySum / bin.count : null,
    observedSyntheticProfitableFraction: bin.count ? bin.profitableTruth / bin.count : null
  }))
}

function statistic(cache, clicks, purchases, lookIndex, optimistic, knownDrift) {
  const key = [clicks, purchases, lookIndex, optimistic, knownDrift].join(':')
  if (!cache.has(key)) {
    cache.set(
      key,
      evaluateAdsetProfitability({
        maturedClicks: clicks,
        purchases,
        costPerClick: COST_PER_CLICK,
        netContributionPerPurchase: NET_CONTRIBUTION,
        evidenceAgeSeconds: 0,
        matureCohort: true,
        attributionConsistent: true,
        stationary: !knownDrift,
        independentOutcomes: true,
        constantCost: true,
        comparableWindow: true,
        prior: optimistic ? { alpha: 20, beta: 80 } : { alpha: 1, beta: 1 },
        campaignAdsets: 3,
        lookIndex,
        familyAlpha: 0.05
      })
    )
  }
  return cache.get(key)
}

function decision(arm, weak, optimistic) {
  if (!weak.evidenceReady) {
    return { decision: 'INCONCLUSIVE', score: null }
  }
  if (arm === 'anytime_exact_binomial_95') {
    return { decision: weak.anytimeExact.decision, score: -weak.anytimeExact.profitablePValue }
  }
  if (arm === 'anytime_hoeffding_95') {
    return { decision: weak.anytime.decision, score: weak.anytime.lowerConversionRate }
  }
  if (arm === 'observed_cpa_roas_min50') {
    const observed = weak.observed
    let result = 'INCONCLUSIVE'
    if (observed.maturedClicks >= 50) {
      if (observed.purchases >= 3 && observed.contributionRoas > 1) {
        result = 'PROFITABLE'
      } else if (observed.contributionRoas < 1) {
        result = 'UNPROFITABLE'
      }
    }
    return { decision: result, score: observed.contributionRoas }
  }
  const probability = arm.startsWith('bayes_optimistic')
    ? optimistic.posteriorProfitProbability
    : weak.posteriorProfitProbability
  const threshold = arm.endsWith('_99') ? 0.99 : 0.95
  return {
    decision:
      probability >= threshold
        ? 'PROFITABLE'
        : probability <= 1 - threshold
          ? 'UNPROFITABLE'
          : 'INCONCLUSIVE',
    score: probability
  }
}

function recordCampaign(metrics, campaign, scenario) {
  const profitable = scenario.rates.map((rate) => rate > BREAK_EVEN)
  const best = Math.max(...scenario.rates)
  let falseProfit = false
  for (let adset = 0; adset < 3; adset += 1) {
    const positive = campaign.profit.has(adset)
    const negative = campaign.loss.has(adset)
    metrics.profitClaims += Number(positive)
    metrics.falseProfitClaims += Number(positive && !profitable[adset])
    metrics.unprofitableClaims += Number(negative)
    metrics.falseUnprofitableClaims += Number(negative && profitable[adset])
    metrics.missedProfitableAdsets += Number(profitable[adset] && !positive)
    metrics.abstainedAdsets += Number(!positive && !negative)
    falseProfit ||= positive && !profitable[adset]
  }
  metrics.campaignsWithFalseProfitClaim += Number(falseProfit)
  if (campaign.first) {
    const first = campaign.first
    metrics.campaignsWithAnyProfitClaim += 1
    metrics.firstSelectedProfitable += Number(profitable[first.adset])
    metrics.firstSelectedTrueBest += Number(scenario.rates[first.adset] === best)
    metrics.firstProfitMaturedClicks.push(first.maturedClicks)
    metrics.firstProfitDeliveredClicks.push(first.deliveredClicks)
    metrics.firstProfitCampaignSpend.push(first.deliveredClicks * 3 * COST_PER_CLICK)
  }
}

function metricReport(arm, metrics, scenario, campaigns) {
  const profitableAdsets = scenario.rates.filter((rate) => rate > BREAK_EVEN).length * campaigns
  const unprofitableAdsets = campaigns * 3 - profitableAdsets
  const fraction = (value, denominator) => (denominator ? value / denominator : null)
  return {
    arm,
    ...metrics,
    denominators: { campaigns, adsets: campaigns * 3, profitableAdsets, unprofitableAdsets },
    campaignFalseProfitRate: metrics.campaignsWithFalseProfitClaim / campaigns,
    campaignFalseProfitMonteCarloInterval: monteCarloWilsonInterval(
      metrics.campaignsWithFalseProfitClaim,
      campaigns
    ),
    falseProfitAmongClaimsRate: fraction(metrics.falseProfitClaims, metrics.profitClaims),
    falseProfitAmongUnprofitableAdsetsRate: fraction(metrics.falseProfitClaims, unprofitableAdsets),
    missedProfitableRate: fraction(metrics.missedProfitableAdsets, profitableAdsets),
    abstentionRate: metrics.abstainedAdsets / (campaigns * 3),
    selectedProfitableRate: fraction(
      metrics.firstSelectedProfitable,
      metrics.campaignsWithAnyProfitClaim
    ),
    selectedTrueBestRate: fraction(
      metrics.firstSelectedTrueBest,
      metrics.campaignsWithAnyProfitClaim
    ),
    firstProfitMaturedClicks: summarizeNumbers(metrics.firstProfitMaturedClicks),
    firstProfitDeliveredClicks: summarizeNumbers(metrics.firstProfitDeliveredClicks),
    firstProfitCampaignSpend: summarizeNumbers(metrics.firstProfitCampaignSpend)
  }
}

function runScenario(scenario, campaigns, random, cache) {
  const metrics = Object.fromEntries(ARMS.map((arm) => [arm, emptyMetrics()]))
  const calibration = { uniform: emptyCalibration(), optimistic: emptyCalibration() }
  for (let campaignIndex = 0; campaignIndex < campaigns; campaignIndex += 1) {
    const paths = [0, 1, 2].map((adset) => cumulativePurchases(scenario, adset, random))
    const states = Object.fromEntries(
      ARMS.map((arm) => [arm, { profit: new Set(), loss: new Set(), first: null }])
    )
    PROFITABILITY_CHECKPOINTS.forEach((deliveredClicks, look) => {
      const maturedClicks = Math.max(0, deliveredClicks - (scenario.maturityLagClicks ?? 0))
      const evidence = paths.map((path) => ({
        weak: statistic(
          cache,
          maturedClicks,
          path[maturedClicks],
          look + 1,
          false,
          !!scenario.knownDrift
        ),
        optimistic: statistic(
          cache,
          maturedClicks,
          path[maturedClicks],
          look + 1,
          true,
          !!scenario.knownDrift
        )
      }))
      if (look === PROFITABILITY_CHECKPOINTS.length - 1) {
        evidence.forEach(({ weak, optimistic }, adset) => {
          updateCalibration(
            calibration.uniform,
            weak.posteriorProfitProbability,
            scenario.rates[adset] > BREAK_EVEN
          )
          updateCalibration(
            calibration.optimistic,
            optimistic.posteriorProfitProbability,
            scenario.rates[adset] > BREAK_EVEN
          )
        })
      }
      for (const arm of ARMS) {
        const state = states[arm]
        const observations = evidence.map(({ weak, optimistic }, adset) => ({
          adset,
          ...decision(arm, weak, optimistic)
        }))
        for (const observation of observations) {
          if (observation.decision === 'PROFITABLE') {
            state.profit.add(observation.adset)
          }
          if (observation.decision === 'UNPROFITABLE') {
            state.loss.add(observation.adset)
          }
        }
        if (!state.first) {
          const eligible = observations.filter(
            (observation) => observation.decision === 'PROFITABLE'
          )
          eligible.sort((left, right) => right.score - left.score || left.adset - right.adset)
          if (eligible.length) {
            state.first = { adset: eligible[0].adset, maturedClicks, deliveredClicks }
          }
        }
      }
    })
    for (const arm of ARMS) {
      recordCampaign(metrics[arm], states[arm], scenario)
    }
  }
  return {
    scenario: scenario.id,
    futureConversionRates: scenario.rates,
    assumptionsHold: scenario.assumptionsHold,
    knownDriftAbstention: !!scenario.knownDrift,
    maturityLagClicks: scenario.maturityLagClicks ?? 0,
    truthDefinition:
      'Future stationary conversion probability times net contribution exceeds click cost; drift/conditioned scenarios deliberately violate model assumptions.',
    arms: ARMS.map((arm) => metricReport(arm, metrics[arm], scenario, campaigns)),
    finalLookPosteriorBins: {
      uniform: calibrationReport(calibration.uniform),
      optimistic: calibrationReport(calibration.optimistic)
    }
  }
}

export function runProfitabilitySimulation({
  seed = 20260921,
  campaignsPerScenario = 500,
  scenarioIds
} = {}) {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isInteger(campaignsPerScenario) ||
    campaignsPerScenario < 1 ||
    campaignsPerScenario > 1000
  ) {
    throw new RangeError('invalid_profitability_simulation_configuration')
  }
  const requested = scenarioIds ?? PROFITABILITY_SCENARIOS.map(({ id }) => id)
  if (
    !Array.isArray(requested) ||
    !requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((id) => !PROFITABILITY_SCENARIOS.some((scenario) => scenario.id === id))
  ) {
    throw new RangeError('invalid_profitability_simulation_scenarios')
  }
  const random = randomGenerator(seed)
  const cache = new Map()
  return freeze({
    schemaVersion: 1,
    kind: 'synthetic_adset_profitability_simulation',
    seed,
    campaignsPerScenario,
    syntheticAdsetIds: ['synthetic_adset_a', 'synthetic_adset_b', 'synthetic_adset_c'],
    campaignCount: requested.length * campaignsPerScenario,
    adsetCount: requested.length * campaignsPerScenario * 3,
    checkpointsDeliveredClicksPerAdset: PROFITABILITY_CHECKPOINTS,
    unitEconomics: {
      costPerClick: COST_PER_CLICK,
      netContributionPerPurchase: NET_CONTRIBUTION,
      breakEvenConversionRate: BREAK_EVEN
    },
    assumptions: [
      'Mature independent Bernoulli click outcomes with stationary conversion probability, except explicitly violated stress scenarios.',
      'Net contribution after product costs, fees and refunds is known and constant; all-in click cost is known and constant.',
      'Each campaign has exactly three equally delivered ad sets; declared looks are fixed in advance.',
      'Lagged cohorts exclude unmatured clicks and their outcomes; decision spend includes every delivered click.',
      'No production advertising data, Typesafe calls, causal profit claims or advertising execution.'
    ],
    procedureNotes: [
      'Bayesian 95/99 percent thresholds are conditional posterior probabilities, not multiplicity-adjusted error guarantees.',
      'Anytime Hoeffding bounds allocate familyAlpha/(3*k*(k+1)) across two tails at each look; sum of family error budgets is at most 0.05 under assumptions.',
      'Exact-binomial one-sided p-values use familyAlpha/(2*3*k*(k+1)) per tail and look under the same fixed IID model; neither arm is a real-world calibration guarantee.',
      'First winner means first qualifying selected ad set; highest posterior probability of profit is not probability of being best.',
      'Repeated-look claim counts count each ad set at most once per direction, including later reversals; campaign false-profit rate uses all campaigns.',
      'Stress-scenario false-profit labels use future rates; pre-drift claims are not necessarily wrong about the past.',
      'Posterior bins describe this synthetic fixed-truth mixture, not a calibrated probability guarantee on live ads.',
      'Wilson intervals reflect finite simulated campaign counts only, not unknown advertising model error.',
      'Decision-time summaries exclude abstaining campaigns; read them together with power and abstention.',
      'All scenarios consume a deterministic shared PRNG stream in requested order; hold scenario ordering fixed for paired reruns.'
    ],
    sources: ['https://dlmf.nist.gov/8.17.E5', 'https://arxiv.org/abs/1810.08240'],
    scenarios: requested.map((id) =>
      runScenario(
        PROFITABILITY_SCENARIOS.find((scenario) => scenario.id === id),
        campaignsPerScenario,
        random,
        cache
      )
    )
  })
}
