// A fictional study policy: deterministic agreement is not causal lift or action authority.
const POLICY = Object.freeze({
  version: 'synthetic-pairwise-purchase-policy.v1',
  objective: 'purchases',
  minimumSpend: 100,
  minimumKeepPurchases: 3,
  maximumKeepCpa: 50,
  minimumKeepRoas: 2,
  maximumPoorRoas: 1,
  minimumHistoryAdAgeDays: 14,
  minimumMaturityHours: 72,
  maxEvidenceAgeSeconds: 300
})
const INSUFFICIENT = 'INSUFFICIENT_DATA'
const SELECTIONS = ['KEEP_A', 'KEEP_B', 'KEEP_BOTH', 'KEEP_NEITHER', INSUFFICIENT]
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0

function validPolicy(policy) {
  return record(policy) && Object.entries(POLICY).every(([key, value]) => policy[key] === value)
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  const parsed = Date.parse(`${value}T00:00:00+00:00`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : null
}

function validWindow(window) {
  const start = day(window?.dateStart)
  const stop = day(window?.dateStop)
  return start !== null && stop !== null && start <= stop
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

function validSnapshot(snapshot, window, group, policy) {
  if (
    !record(snapshot) ||
    !record(snapshot.metrics) ||
    snapshot.trackingIntegrity !== 'verified' ||
    ['dateStart', 'dateStop'].some((key) => snapshot[key] !== window[key]) ||
    ['timezone', 'attribution'].some((key) => snapshot[key] !== group[key]) ||
    !['spend', 'purchases', 'revenue'].every((key) => nonnegative(snapshot.metrics[key]))
  ) {
    return false
  }
  const observedAt = timestamp(group.observedAt)
  const observedThrough = timestamp(snapshot.observedThrough)
  const completedWindow = day(window.dateStop) + 86_399_000
  const fetchedAge = observedAt - timestamp(snapshot.fetchedAt)
  const maturityAge = observedAt - observedThrough
  return (
    observedThrough === completedWindow &&
    Number.isFinite(fetchedAge) &&
    fetchedAge >= 0 &&
    fetchedAge <= policy.maxEvidenceAgeSeconds * 1000 &&
    Number.isFinite(maturityAge) &&
    maturityAge >= policy.minimumMaturityHours * 60 * 60 * 1000
  )
}

function validGroup(group, ads) {
  return (
    record(group) &&
    validWindow(group) &&
    ['company', 'accountId', 'campaignId', 'adsetId', 'currency', 'timezone', 'attribution'].every(
      (key) => typeof group[key] === 'string' && group[key].length > 0
    ) &&
    group.objective === 'purchases' &&
    group.parentStatus === 'ACTIVE' &&
    group.trackingIntegrity === 'verified' &&
    group.complete === true &&
    group.expectedSiblingCount === ads.length &&
    group.comparisonScope === 'synthetic_complete_two_ad_set' &&
    Number.isFinite(timestamp(group.observedAt)) &&
    new Set(ads.map((ad) => ad.adId)).size === ads.length &&
    ads.every(
      (ad) =>
        typeof ad.adId === 'string' &&
        ad.adId.length > 0 &&
        ad.adsetId === group.adsetId &&
        ad.status === 'ACTIVE' &&
        nonnegative(ad.ageDays)
    )
  )
}

function economicClassification(metrics, policy) {
  if (metrics.spend < policy.minimumSpend) {
    return 'unknown'
  }
  const cpa = metrics.purchases > 0 ? metrics.spend / metrics.purchases : null
  const roas = metrics.spend > 0 ? metrics.revenue / metrics.spend : null
  if (
    metrics.purchases >= policy.minimumKeepPurchases &&
    cpa !== null &&
    cpa <= policy.maximumKeepCpa &&
    roas !== null &&
    roas >= policy.minimumKeepRoas
  ) {
    return 'healthy'
  }
  if (
    metrics.purchases === 0 ||
    (cpa !== null && cpa > policy.maximumKeepCpa) ||
    (roas !== null && roas < policy.maximumPoorRoas)
  ) {
    return 'poor'
  }
  return 'unknown'
}

function validHistory(history, group, ads, policy) {
  if (
    !record(history) ||
    !record(history.context) ||
    !validWindow(history) ||
    day(history.dateStop) >= day(group.dateStart) ||
    ['adsetId', 'currency', 'objective', 'timezone', 'attribution'].some(
      (key) => history.context[key] !== group[key]
    ) ||
    !validSnapshot(history.adset, history, group, policy) ||
    !Array.isArray(history.ads) ||
    history.ads.length !== ads.length ||
    new Set(history.ads.map((ad) => ad?.adId)).size !== ads.length
  ) {
    return false
  }
  return history.ads.every(
    (ad) =>
      record(ad) &&
      ads.some((current) => current.adId === ad.adId) &&
      validSnapshot(ad.snapshot, history, group, policy)
  )
}

export function numericPairwiseSelection(state) {
  if (
    !record(state) ||
    !Array.isArray(state.ads) ||
    state.ads.length !== 2 ||
    !state.ads.every((ad) => record(ad) && ['A', 'B'].includes(ad.slot)) ||
    new Set(state.ads.map((ad) => ad.slot)).size !== 2
  ) {
    throw new TypeError('invalid_synthetic_ad_pair')
  }
  const { ads, group, simulationPolicy: policy, historicalBaseline: history } = state
  if (
    !validPolicy(policy) ||
    !validGroup(group, ads) ||
    !ads.every((ad) => validSnapshot(ad.current, group, group, policy))
  ) {
    return INSUFFICIENT
  }
  const needsHistory = ads.some((ad) => ad.current.metrics.spend < policy.minimumSpend)
  if (
    needsHistory &&
    (!validHistory(history, group, ads, policy) ||
      ads.some(
        (ad) =>
          ad.current.metrics.spend < policy.minimumSpend &&
          (ad.ageDays < policy.minimumHistoryAdAgeDays ||
            timestamp(group.observedAt) - ad.ageDays * 86_400_000 > day(history.dateStart))
      ))
  ) {
    return INSUFFICIENT
  }
  const classes = Object.fromEntries(
    ads.map((ad) => {
      const metrics =
        ad.current.metrics.spend >= policy.minimumSpend
          ? ad.current.metrics
          : history.ads.find((historical) => historical.adId === ad.adId).snapshot.metrics
      return [ad.slot, economicClassification(metrics, policy)]
    })
  )
  if (classes.A === 'unknown' || classes.B === 'unknown') {
    return INSUFFICIENT
  }
  if (classes.A === classes.B) {
    return classes.A === 'healthy' ? 'KEEP_BOTH' : 'KEEP_NEITHER'
  }
  return classes.A === 'healthy' ? 'KEEP_A' : 'KEEP_B'
}

function validQuestions(questions) {
  if (
    !record(questions) ||
    Object.keys(questions).length !== 1 ||
    !record(questions.selection) ||
    questions.selection.type !== 'choice' ||
    !record(questions.selection.criteria)
  ) {
    return false
  }
  const criteria = Object.keys(questions.selection.criteria)
  return (
    criteria.length === SELECTIONS.length && SELECTIONS.every((value) => criteria.includes(value))
  )
}

export function evaluatePairwiseNumericReference(request) {
  if (request?.capability !== 'evaluation_ad_pairwise_selection') {
    return { status: 'skipped', elapsedMs: 0, errorCode: 'not_applicable' }
  }
  const started = performance.now()
  try {
    if (!validQuestions(request.questions)) {
      throw new TypeError('invalid_synthetic_pairwise_questions')
    }
    const value = numericPairwiseSelection(request.state)
    return {
      status: 'success',
      elapsedMs: performance.now() - started,
      answers: { selection: { value } },
      usage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0
    }
  } catch {
    return { status: 'error', elapsedMs: performance.now() - started, errorCode: 'invalid_request' }
  }
}
