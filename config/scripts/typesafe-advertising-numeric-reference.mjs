// A fictional study-policy reference, not the deployed optimizer or advertising authority.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const nullableRatio = (numerator, denominator) =>
  nonnegative(numerator) && nonnegative(denominator) && denominator > 0
    ? numerator / denominator
    : null
const noAction = (ads) => Object.fromEntries(ads.map((ad) => [ad.key, 'NO_ACTION']))
const nativeId = (value) => typeof value === 'string' && /^[0-9]{5,30}$/.test(value)
const dateOnly = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value

function validGroupIdentity(group) {
  if (
    !['omnirogue', 'betacorp'].includes(group.company) ||
    typeof group.accountId !== 'string' ||
    !/^act_[0-9]{5,30}$/.test(group.accountId) ||
    !nativeId(group.campaignId) ||
    !nativeId(group.adsetId) ||
    !dateOnly(group.dateStart) ||
    !dateOnly(group.dateStop) ||
    group.dateStop < group.dateStart ||
    typeof group.timezone !== 'string' ||
    !group.timezone.trim()
  ) {
    return false
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: group.timezone })
    return true
  } catch {
    return false
  }
}

function validPolicy(policy) {
  return (
    record(policy) &&
    policy.version === 'synthetic-purchase-policy.v1' &&
    policy.objective === 'purchases' &&
    [
      'minimumSpend',
      'minimumKeepPurchases',
      'maximumKeepCpa',
      'minimumKeepRoas',
      'maximumPauseRoas',
      'maxEvidenceAgeSeconds'
    ].every((key) => nonnegative(policy[key]))
  )
}

function fresh(value, observedAt, maximumSeconds) {
  if (typeof value !== 'string') {
    return false
  }
  const elapsed = observedAt - Date.parse(value)
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= maximumSeconds * 1000
}

function validGroup(group, ads, policy) {
  if (
    !record(group) ||
    !validGroupIdentity(group) ||
    group.complete !== true ||
    group.parentStatus !== 'ACTIVE' ||
    group.attributionMature !== true ||
    group.attributionConsistent !== true ||
    !Number.isSafeInteger(group.expectedSiblingCount) ||
    group.expectedSiblingCount !== ads.length
  ) {
    return false
  }
  const observedAt = Date.parse(group.observedAt)
  const ids = new Set()
  return (
    Number.isFinite(observedAt) &&
    ads.every(({ evidence }) => {
      const target = evidence?.target
      if (
        !record(target) ||
        target.objectType !== 'ad' ||
        !nativeId(target.nativeId) ||
        ids.has(target.nativeId) ||
        ['company', 'accountId', 'campaignId', 'adsetId'].some((key) => target[key] !== group[key])
      ) {
        return false
      }
      ids.add(target.nativeId)
      return (
        evidence.currency === 'USD' &&
        ['dateStart', 'dateStop', 'timezone'].every((key) => evidence[key] === group[key]) &&
        fresh(evidence.measuredAt, observedAt, policy.maxEvidenceAgeSeconds) &&
        fresh(evidence.fetchedAt, observedAt, policy.maxEvidenceAgeSeconds)
      )
    })
  )
}

function recommendation(evidence, policy) {
  if (evidence?.status !== 'ACTIVE' || evidence.effectiveStatus !== 'ACTIVE') {
    return 'NO_ACTION'
  }
  const metrics = evidence.metrics
  if (
    !record(metrics) ||
    !['spend', 'purchases', 'revenue'].every((key) => nonnegative(metrics[key])) ||
    metrics.spend < policy.minimumSpend
  ) {
    return 'NO_ACTION'
  }
  const cpa = nullableRatio(metrics.spend, metrics.purchases)
  const roas = nullableRatio(metrics.revenue, metrics.spend)
  if (
    metrics.purchases >= policy.minimumKeepPurchases &&
    cpa !== null &&
    cpa <= policy.maximumKeepCpa &&
    roas !== null &&
    roas >= policy.minimumKeepRoas
  ) {
    return 'KEEP_RUNNING'
  }
  if (
    metrics.purchases === 0 ||
    (cpa !== null && cpa > policy.maximumKeepCpa) ||
    (roas !== null && roas < policy.maximumPauseRoas)
  ) {
    return 'PAUSE'
  }
  return 'NO_ACTION'
}

export function numericAdvertisingDecisions(state) {
  if (
    !record(state) ||
    !Array.isArray(state.ads) ||
    state.ads.length !== 3 ||
    !state.ads.every((ad) => record(ad) && ['ad_a', 'ad_b', 'ad_c'].includes(ad.key)) ||
    new Set(state.ads.map((ad) => ad.key)).size !== state.ads.length
  ) {
    throw new TypeError('invalid_synthetic_ad_group')
  }
  const { ads, group, simulationPolicy: policy } = state
  if (!validPolicy(policy) || !validGroup(group, ads, policy)) {
    return noAction(ads)
  }
  const decisions = Object.fromEntries(
    ads.map((ad) => [ad.key, recommendation(ad.evidence, policy)])
  )
  const active = ads.filter((ad) => ad.evidence.status === 'ACTIVE')
  // Never convert an advisory sibling comparison into closing the entire ad set.
  if (active.length > 0 && active.every((ad) => decisions[ad.key] === 'PAUSE')) {
    return noAction(ads)
  }
  return decisions
}

export function evaluateNumericAdvertisingReference(request) {
  if (request?.capability !== 'evaluation_ad_sibling_selection') {
    return { status: 'skipped', elapsedMs: 0, errorCode: 'not_applicable' }
  }
  const started = performance.now()
  try {
    const values = numericAdvertisingDecisions(request.state)
    const questionIds = Object.keys(request.questions ?? {})
    if (questionIds.length !== 3 || !Object.keys(values).every((id) => questionIds.includes(id))) {
      throw new TypeError('invalid_synthetic_ad_questions')
    }
    return {
      status: 'success',
      elapsedMs: performance.now() - started,
      answers: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }])),
      usage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0
    }
  } catch {
    return { status: 'error', elapsedMs: performance.now() - started, errorCode: 'invalid_request' }
  }
}
