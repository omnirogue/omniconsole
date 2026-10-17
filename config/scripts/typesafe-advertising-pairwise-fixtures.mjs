export const PAIRWISE_POLICY = Object.freeze({
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

const OBSERVED_AT = '2026-09-21T12:00:00+00:00'
const FETCHED_AT = '2026-09-21T11:59:30+00:00'
const AD_IDS = ['900101', '900102']
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const ratio = (numerator, denominator) =>
  nonnegative(numerator) && nonnegative(denominator) && denominator > 0
    ? numerator / denominator
    : null

function snapshot(values, window, overrides = {}) {
  const [spend, purchases, revenue, linkClicks = 40, impressions = 2000] = values
  const result = {
    ...window,
    timezone: 'UTC',
    attribution: '7d_click_1d_view',
    observedThrough: `${window.dateStop}T23:59:59+00:00`,
    fetchedAt: FETCHED_AT,
    trackingIntegrity: 'verified',
    metrics: { spend, purchases, revenue, linkClicks, impressions },
    ...overrides
  }
  const cpa = ratio(spend, purchases)
  const roas = ratio(revenue, spend)
  const observedAge = Date.parse(OBSERVED_AT) - Date.parse(result.observedThrough)
  const fetchedAge = Date.parse(OBSERVED_AT) - Date.parse(result.fetchedAt)
  result.computed = {
    costPerPurchase: cpa,
    revenueReturnOnSpend: roas,
    linkClickThroughRate: ratio(linkClicks, impressions),
    metricsComplete: [spend, purchases, revenue].every(nonnegative),
    spendThresholdMet: nonnegative(spend) && spend >= PAIRWISE_POLICY.minimumSpend,
    purchaseCountThresholdMet:
      nonnegative(purchases) && purchases >= PAIRWISE_POLICY.minimumKeepPurchases,
    cpaAtOrBelowTarget: cpa !== null && cpa <= PAIRWISE_POLICY.maximumKeepCpa,
    cpaAboveTarget: cpa !== null && cpa > PAIRWISE_POLICY.maximumKeepCpa,
    roasAtOrAboveTarget: roas !== null && roas >= PAIRWISE_POLICY.minimumKeepRoas,
    roasBelowFloor: roas !== null && roas < PAIRWISE_POLICY.maximumPoorRoas,
    zeroPurchases: purchases === 0,
    attributionMature: observedAge >= PAIRWISE_POLICY.minimumMaturityHours * 3_600_000,
    fetchedWithinAgeLimit:
      fetchedAge >= 0 && fetchedAge <= PAIRWISE_POLICY.maxEvidenceAgeSeconds * 1000,
    windowPredatesDecision: observedAge >= 0
  }
  return result
}

function sumMetrics(left, right) {
  return [0, 1, 2, 3, 4].map((index) => {
    const defaults = [0, 0, 0, 40, 2000]
    const a = left[index] === undefined ? defaults[index] : left[index]
    const b = right[index] === undefined ? defaults[index] : right[index]
    return nonnegative(a) && nonnegative(b) ? a + b : null
  })
}

export function buildPairwiseState(scenario, contextCondition, presentationOrder) {
  const currentWindow = {
    dateStart: '2026-09-15',
    dateStop: scenario.delayed ? '2026-09-20' : '2026-09-17'
  }
  const historyWindow = scenario.futureHistory
    ? { dateStart: '2026-09-22', dateStop: '2026-10-05' }
    : { dateStart: '2026-09-01', dateStop: '2026-09-14' }
  const group = {
    company: 'omnirogue',
    accountId: 'act_900000',
    campaignId: '900001',
    adsetId: '900002',
    currency: 'USD',
    objective: 'purchases',
    observedAt: OBSERVED_AT,
    ...currentWindow,
    timezone: 'UTC',
    attribution: '7d_click_1d_view',
    parentStatus: 'ACTIVE',
    complete: true,
    expectedSiblingCount: 2,
    trackingIntegrity: scenario.trackingBroken ? 'broken' : 'verified',
    comparisonScope: 'synthetic_complete_two_ad_set',
    precomputed: { hierarchyMatches: true, currentWindowsComparable: true }
  }
  const order = presentationOrder === 'AB' ? [0, 1] : [1, 0]
  const state = {
    simulationPolicy: { ...PAIRWISE_POLICY },
    group,
    ads: order.map((index, position) => ({
      slot: position === 0 ? 'A' : 'B',
      adId: AD_IDS[index],
      adsetId: group.adsetId,
      status: 'ACTIVE',
      ageDays: scenario.ageDays ?? 45,
      current: snapshot(scenario.current[index], currentWindow)
    }))
  }
  if (contextCondition === 'with_baselines') {
    const overrides = scenario.staleHistory ? { fetchedAt: '2026-09-21T10:00:00+00:00' } : {}
    state.historicalBaseline = {
      context: {
        adsetId: group.adsetId,
        currency: group.currency,
        objective: group.objective,
        timezone: group.timezone,
        attribution: group.attribution
      },
      ...historyWindow,
      computed: {
        windowEndsBeforeCurrentStarts: historyWindow.dateStop < currentWindow.dateStart,
        coversPrior14Days: true,
        adAgeMeetsHistoryMinimum:
          (scenario.ageDays ?? 45) >= PAIRWISE_POLICY.minimumHistoryAdAgeDays,
        adsExistedThroughoutWindow:
          Date.parse(OBSERVED_AT) - (scenario.ageDays ?? 45) * 86_400_000 <=
          Date.parse(`${historyWindow.dateStart}T00:00:00+00:00`)
      },
      adset: snapshot(sumMetrics(...scenario.history), historyWindow, overrides),
      ads: order.map((index) => ({
        adId: AD_IDS[index],
        snapshot: snapshot(scenario.history[index], historyWindow, overrides)
      })),
      interpretation:
        'Historical attributed revenue is not profit, Stripe cash or causal uplift. Ad-set totals are contextual, not a quota requiring one winner.'
    }
  }
  return state
}

export const PAIRWISE_SCENARIOS = [
  {
    id: 'clear-current',
    split: 'development',
    current: [
      [150, 5, 600],
      [180, 1, 70]
    ],
    history: [
      [800, 30, 3000],
      [800, 4, 300]
    ],
    labels: { current_only: 'FIRST', with_baselines: 'FIRST' },
    rationale:
      'Mature current evidence is sufficient: the first ad qualifies; the second exceeds the CPA ceiling and falls below the ROAS floor.'
  },
  {
    id: 'history-fills-low-delivery',
    split: 'development',
    current: [
      [35, 1, 100],
      [30, 0, 0]
    ],
    history: [
      [600, 20, 2400],
      [600, 3, 240]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'FIRST' },
    rationale:
      'Current low spend supports abstention. Eligible mature prior evidence supplies adequate sample support for the first ad, not the second.'
  },
  {
    id: 'retain-two-good-ads',
    split: 'development',
    current: [
      [160, 4, 400],
      [160, 8, 960]
    ],
    history: [
      [500, 5, 400],
      [500, 30, 3000]
    ],
    labels: { current_only: 'KEEP_BOTH', with_baselines: 'KEEP_BOTH' },
    rationale:
      'Both ads meet the absolute current purchase policy. A stronger sibling and previously weak history do not justify removing the other qualifying ad.'
  },
  {
    id: 'clicks-are-not-purchases',
    split: 'holdout',
    current: [
      [180, 1, 60, 900, 10000],
      [180, 6, 720, 100, 10000]
    ],
    history: [
      [900, 4, 300, 4500, 50000],
      [900, 30, 3600, 500, 50000]
    ],
    labels: { current_only: 'SECOND', with_baselines: 'SECOND' },
    rationale:
      'The first ad has substantially higher link CTR but poor mature purchase economics. The second qualifies for the purchase objective.'
  },
  {
    id: 'history-supports-both',
    split: 'holdout',
    current: [
      [45, 1, 100],
      [40, 1, 100]
    ],
    history: [
      [800, 25, 2500],
      [750, 20, 2250]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'KEEP_BOTH' },
    rationale:
      'Both current samples are below the minimum spend. Eligible historical samples support retaining both; no single-winner constraint exists.'
  },
  {
    id: 'both-mature-and-poor',
    split: 'holdout',
    current: [
      [200, 1, 80],
      [180, 0, 0]
    ],
    history: [
      [800, 6, 600],
      [700, 3, 240]
    ],
    labels: { current_only: 'KEEP_NEITHER', with_baselines: 'KEEP_NEITHER' },
    rationale:
      'Complete mature current evidence places both below the fictional policy. KEEP_NEITHER is an advisory comparison, not authority to pause the ad set.'
  },
  {
    id: 'new-under-delivered-ads',
    split: 'holdout',
    ageDays: 7,
    current: [
      [20, 0, 0],
      [15, 0, 0]
    ],
    history: [
      [20, 0, 0],
      [15, 0, 0]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'INSUFFICIENT_DATA' },
    rationale:
      'Two young low-delivery ads lack sufficient observations. Prior-period fields cannot establish a valid mature history for ads younger than that period.'
  },
  {
    id: 'conversions-still-arriving',
    split: 'holdout',
    delayed: true,
    current: [
      [180, 0, 0],
      [180, 1, 80]
    ],
    history: [
      [700, 28, 2800],
      [700, 4, 320]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'INSUFFICIENT_DATA' },
    rationale:
      'Current conversions have not completed the declared attribution-maturity interval. Historical strength cannot remove that uncertainty or authorize a present loser judgment.'
  },
  {
    id: 'tracking-break',
    split: 'holdout',
    trackingBroken: true,
    current: [
      [200, 0, 0],
      [200, 0, 0]
    ],
    history: [
      [800, 25, 2500],
      [800, 20, 2400]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'INSUFFICIENT_DATA' },
    rationale:
      'A known current tracking break makes zero recorded purchases unreliable. Past performance cannot validate the broken current measurements.'
  },
  {
    id: 'future-history-leakage',
    split: 'holdout',
    futureHistory: true,
    current: [
      [35, 1, 100],
      [30, 0, 0]
    ],
    history: [
      [600, 24, 2400],
      [600, 2, 150]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'INSUFFICIENT_DATA' },
    rationale:
      'Current samples are sparse. The additional alleged historical window lies after the decision time and must not provide future-label leakage.'
  },
  {
    id: 'recent-recovery-authoritative',
    split: 'holdout',
    current: [
      [200, 5, 600],
      [180, 6, 600]
    ],
    history: [
      [1000, 5, 400],
      [1000, 4, 300]
    ],
    labels: { current_only: 'KEEP_BOTH', with_baselines: 'KEEP_BOTH' },
    rationale:
      'Adequate mature recent observations support both ads under the current policy. Additional older poor performance must not override the predeclared recency rule.'
  },
  {
    id: 'stale-history',
    split: 'holdout',
    staleHistory: true,
    current: [
      [40, 1, 100],
      [35, 0, 0]
    ],
    history: [
      [600, 20, 2400],
      [600, 3, 240]
    ],
    labels: { current_only: 'INSUFFICIENT_DATA', with_baselines: 'INSUFFICIENT_DATA' },
    rationale:
      'Sparse current observations require more evidence, but the prior-period snapshot is outside the declared refresh limit and is ineligible for this comparison.'
  }
]
