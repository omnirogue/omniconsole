// Evaluation-only; modeled profitability never authorizes an advertising action.
const MAX_CLICKS = 10000
const DECISIONS = Object.freeze({ yes: 'PROFITABLE', no: 'UNPROFITABLE', wait: 'INCONCLUSIVE' })
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const integer = (value, minimum, maximum) =>
  Number.isInteger(value) && value >= minimum && value <= maximum

function logAdd(left, right) {
  if (left === -Infinity) {
    return right
  }
  const maximum = Math.max(left, right)
  return maximum + Math.log1p(Math.exp(Math.min(left, right) - maximum))
}

// Beta/binomial identity, accumulated in log space: https://dlmf.nist.gov/8.17.E5
export function betaSurvival(alpha, beta, threshold) {
  if (
    !integer(alpha, 1, 20000) ||
    !integer(beta, 1, 20000) ||
    alpha + beta > 20002 ||
    !finite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new RangeError('invalid_beta_parameters')
  }
  if (threshold === 0) {
    return 1
  }
  if (threshold === 1) {
    return 0
  }
  const trials = alpha + beta - 1
  const logOdds = Math.log(threshold) - Math.log1p(-threshold)
  let term = trials * Math.log1p(-threshold)
  let sum = -Infinity
  for (let successes = 0; successes < alpha; successes += 1) {
    sum = logAdd(sum, term)
    term += Math.log(trials - successes) - Math.log(successes + 1) + logOdds
  }
  return Math.min(1, Math.max(0, Math.exp(sum)))
}

export function betaQuantile(alpha, beta, probability) {
  if (!finite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('invalid_beta_quantile')
  }
  betaSurvival(alpha, beta, 0.5)
  if (probability === 0 || probability === 1) {
    return probability
  }
  let lower = 0
  let upper = 1
  for (let step = 0; step < 44; step += 1) {
    const middle = (lower + upper) / 2
    if (betaSurvival(alpha, beta, middle) > 1 - probability) {
      lower = middle
    } else {
      upper = middle
    }
  }
  return (lower + upper) / 2
}

export function anytimeConversionInterval({
  clicks,
  purchases,
  campaignAdsets = 3,
  lookIndex = 1,
  familyAlpha = 0.05
}) {
  if (
    !integer(clicks, 1, MAX_CLICKS) ||
    !integer(purchases, 0, clicks) ||
    !integer(campaignAdsets, 1, 1000) ||
    !integer(lookIndex, 1, 10000) ||
    !finite(familyAlpha) ||
    familyAlpha <= 0 ||
    familyAlpha >= 0.5
  ) {
    throw new RangeError('invalid_anytime_parameters')
  }
  // Union bound over both tails, every predeclared look, and all campaign ad sets.
  const alphaAtLook = familyAlpha / (campaignAdsets * lookIndex * (lookIndex + 1))
  const radius = Math.sqrt(Math.log(2 / alphaAtLook) / (2 * clicks))
  const rate = purchases / clicks
  return {
    lowerConversionRate: Math.max(0, rate - radius),
    upperConversionRate: Math.min(1, rate + radius),
    alphaAtLook,
    campaignFamilyAlpha: familyAlpha,
    campaignAdsets,
    lookIndex,
    procedure: 'hoeffding-alpha-spending.v1',
    monitoringScope: 'Predeclared sample-size checkpoints; no reset or uncounted adaptive looks.'
  }
}

export function exactBinomialProfitabilityTest(input) {
  const interval = anytimeConversionInterval(input)
  const { clicks, purchases, breakEvenConversionRate: threshold } = input
  if (!finite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('invalid_break_even_rate')
  }
  const profitablePValue =
    purchases === 0 ? 1 : betaSurvival(clicks - purchases + 1, purchases, 1 - threshold)
  const unprofitablePValue =
    purchases === clicks ? 1 : betaSurvival(purchases + 1, clicks - purchases, threshold)
  const alphaPerTailAtLook = interval.alphaAtLook / 2
  return {
    decision:
      profitablePValue <= alphaPerTailAtLook
        ? DECISIONS.yes
        : unprofitablePValue <= alphaPerTailAtLook
          ? DECISIONS.no
          : DECISIONS.wait,
    profitablePValue,
    unprofitablePValue,
    alphaPerTailAtLook,
    campaignFamilyAlpha: interval.campaignFamilyAlpha,
    campaignAdsets: interval.campaignAdsets,
    lookIndex: interval.lookIndex,
    procedure: 'exact-binomial-alpha-spending.v1'
  }
}

function assumptionsInvalid(input) {
  const reasons = []
  for (const key of [
    'matureCohort',
    'attributionConsistent',
    'stationary',
    'independentOutcomes',
    'constantCost',
    'comparableWindow'
  ]) {
    if (input[key] !== true) {
      reasons.push(`${key}_not_confirmed`)
    }
  }
  if (
    !finite(input.evidenceAgeSeconds) ||
    input.evidenceAgeSeconds < 0 ||
    !finite(input.maxEvidenceAgeSeconds) ||
    input.maxEvidenceAgeSeconds < 0 ||
    input.evidenceAgeSeconds > input.maxEvidenceAgeSeconds
  ) {
    reasons.push('stale_or_unknown_evidence')
  }
  if (!finite(input.netContributionPerPurchase) || input.netContributionPerPurchase <= 0) {
    reasons.push('net_contribution_unknown_or_nonpositive')
  }
  if (!finite(input.costPerClick) || input.costPerClick <= 0) {
    reasons.push('click_cost_unknown_or_nonpositive')
  }
  if (
    !integer(input.maturedClicks, 1, MAX_CLICKS) ||
    !integer(input.purchases, 0, input.maturedClicks)
  ) {
    reasons.push('invalid_or_missing_mature_counts')
  }
  return reasons
}

function abstention(reasons) {
  return {
    model: 'beta-bernoulli-fixed-margin.v1',
    authorization: 'NONE',
    evidenceReady: false,
    reasons,
    posteriorProfitProbability: null,
    breakEvenConversionRate: null,
    posteriorDecision: DECISIONS.wait,
    posteriorInterval: null,
    observed: null,
    prior: null,
    posterior: null,
    posteriorThreshold: null,
    anytime: { decision: DECISIONS.wait, lowerConversionRate: null, upperConversionRate: null },
    anytimeExact: { decision: DECISIONS.wait, profitablePValue: null, unprofitablePValue: null }
  }
}

export function evaluateAdsetProfitability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return abstention(['missing_input'])
  }
  const input = {
    maxEvidenceAgeSeconds: 300,
    prior: { alpha: 1, beta: 1 },
    posteriorThreshold: 0.95,
    campaignAdsets: 3,
    lookIndex: 1,
    familyAlpha: 0.05,
    ...raw
  }
  const reasons = assumptionsInvalid(input)
  if (!input.prior || !integer(input.prior.alpha, 1, 1000) || !integer(input.prior.beta, 1, 1000)) {
    reasons.push('invalid_prior')
  }
  if (
    !finite(input.posteriorThreshold) ||
    input.posteriorThreshold <= 0.5 ||
    input.posteriorThreshold >= 1
  ) {
    reasons.push('invalid_posterior_threshold')
  }
  if (reasons.length) {
    return abstention(reasons)
  }
  let interval
  try {
    interval = anytimeConversionInterval({
      clicks: input.maturedClicks,
      purchases: input.purchases,
      campaignAdsets: input.campaignAdsets,
      lookIndex: input.lookIndex,
      familyAlpha: input.familyAlpha
    })
  } catch {
    return abstention(['invalid_monitoring_plan'])
  }
  const breakEven = input.costPerClick / input.netContributionPerPurchase
  if (!finite(breakEven)) {
    return abstention(['invalid_unit_economics'])
  }
  const alpha = input.prior.alpha + input.purchases
  const beta = input.prior.beta + input.maturedClicks - input.purchases
  const probability = breakEven >= 1 ? 0 : betaSurvival(alpha, beta, breakEven)
  const observedRate = input.purchases / input.maturedClicks
  const spend = input.maturedClicks * input.costPerClick
  const contribution = input.purchases * input.netContributionPerPurchase
  if (!finite(spend) || !finite(contribution)) {
    return abstention(['unit_economics_overflow'])
  }
  const posteriorDecision =
    probability >= input.posteriorThreshold
      ? DECISIONS.yes
      : probability <= 1 - input.posteriorThreshold
        ? DECISIONS.no
        : DECISIONS.wait
  const anytimeDecision =
    interval.lowerConversionRate > breakEven
      ? DECISIONS.yes
      : interval.upperConversionRate < breakEven
        ? DECISIONS.no
        : DECISIONS.wait
  return {
    model: 'beta-bernoulli-fixed-margin.v1',
    authorization: 'NONE',
    evidenceReady: true,
    reasons: [],
    posteriorProfitProbability: probability,
    breakEvenConversionRate: breakEven,
    posteriorThreshold: input.posteriorThreshold,
    posteriorDecision,
    prior: { alpha: input.prior.alpha, beta: input.prior.beta },
    posterior: { alpha, beta },
    posteriorInterval:
      input.includePosteriorInterval === true
        ? {
            level: 0.95,
            lowerConversionRate: betaQuantile(alpha, beta, 0.025),
            upperConversionRate: betaQuantile(alpha, beta, 0.975)
          }
        : null,
    observed: {
      conversionRate: observedRate,
      maturedClicks: input.maturedClicks,
      purchases: input.purchases,
      spend,
      costPerPurchase: input.purchases ? spend / input.purchases : null,
      contributionRoas: contribution / spend,
      netContributionAfterAdSpend: contribution - spend,
      posteriorExpectedNetContributionPerClick:
        (alpha / (alpha + beta)) * input.netContributionPerPurchase - input.costPerClick
    },
    anytime: { ...interval, decision: anytimeDecision },
    anytimeExact: exactBinomialProfitabilityTest({
      clicks: input.maturedClicks,
      purchases: input.purchases,
      campaignAdsets: input.campaignAdsets,
      lookIndex: input.lookIndex,
      familyAlpha: input.familyAlpha,
      breakEvenConversionRate: Math.min(1, breakEven)
    }),
    interpretation:
      'Conditional modeled probability, not calibrated real-world confidence or probability of being the best ad set.'
  }
}
