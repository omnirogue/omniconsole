import { rotateAdsetObservations } from './typesafe-adset-profitability-fixtures.mjs'

const clear = [
  [10000, 1800],
  [10000, 490],
  [10000, 200]
]
const negative = [
  [1000, 30],
  [1000, 25],
  [1000, 20]
]
const sparse = [
  [50, 8],
  [50, 2],
  [50, 0]
]
const names = ['ADSET_A', 'ADSET_B', 'ADSET_C']
const rows = []

function add(family, split, index, observations, options, winner, readiness, rationale) {
  rows.push({ family, split, index, observations, options, winner, readiness, rationale })
}

for (let index = 0; index < 3; index++) {
  const suffix = index + 1
  add(
    'development-mature-clear',
    'development',
    suffix,
    rotateAdsetObservations(clear, index),
    {},
    names[index],
    'READY_FOR_HUMAN_REVIEW',
    'A large matured purchase cohort supports a unique high-probability candidate and simultaneous sequential profitability evidence, but only human review.'
  )
  add(
    'development-all-negative',
    'development',
    suffix,
    rotateAdsetObservations(negative, index),
    {},
    names[index],
    'OBSERVE',
    'The least unlikely adset is still not supported as profitable; relative ranking does not satisfy an absolute profitability threshold.'
  )
  add(
    'development-sparse',
    'development',
    suffix,
    rotateAdsetObservations(sparse, index),
    {},
    names[index],
    'OBSERVE',
    'A promising small cohort is ranked but does not establish the simultaneous sequential lower bound required for high-confidence review.'
  )
  const tied = rotateAdsetObservations(
    [
      [10000, 1800],
      [10000, 1800],
      [10000, 200]
    ],
    index
  )
  add(
    'development-identical-ties',
    'development',
    suffix,
    tied,
    {},
    'TIE',
    'OBSERVE',
    'Two identical posterior distributions do not justify inventing a unique best adset, even when both are strongly supported as profitable.'
  )
}

const invalid = (family, index, options, rationale) =>
  add(family, 'holdout', index, clear, options, 'INSUFFICIENT_EVIDENCE', 'OBSERVE', rationale)

invalid(
  'unknown-unit-economics',
  1,
  { netContributionPerPurchase: null },
  'Missing net contribution prevents converting purchase probability into profit probability; gross revenue and ROAS cannot replace unknown costs.'
)
invalid(
  'unknown-unit-economics',
  2,
  { adsets: { ADSET_B: { netContributionPerPurchase: null } } },
  'One sibling has unknown unit economics, so the campaign-wide claim of the highest probability is not established for every candidate.'
)
invalid(
  'unknown-unit-economics',
  3,
  {
    guards: { netContributionVerified: false },
    notes:
      'The displayed margin is gross sale price. Shipping, fees, refunds and fulfilment have not been deducted.'
  },
  'A numeric margin field containing gross sales is invalid profitability evidence, even if its computed posterior appears decisive.'
)

invalid(
  'unmatured-outcome-cohorts',
  1,
  {
    input: { matureCohort: false },
    notes: 'The purchase window is seven days but these clicks are only one day old.'
  },
  'Immature clicks must not be treated as settled purchase failures; confidence calculations cannot repair an unresolved conversion window.'
)
invalid(
  'unmatured-outcome-cohorts',
  2,
  { adsets: { ADSET_C: { input: { matureCohort: false } } } },
  'One sibling remains subject to conversion lag, making a complete campaign ranking premature even when another sibling looks strong.'
)
invalid(
  'unmatured-outcome-cohorts',
  3,
  {
    input: { attributionConsistent: false },
    notes: 'The delayed purchase backfill disagrees with the reporting extract.'
  },
  'Unresolved delayed-attribution contradictions prevent treating the displayed counts as authoritative observations.'
)

invalid(
  'purchase-event-mapping',
  1,
  {
    guards: { purchaseEventVerified: false },
    notes: 'The event named Purchase actually fires on a lead form submission.'
  },
  'A purchase-labelled event that records leads does not supply purchase outcomes or profit evidence.'
)
invalid(
  'purchase-event-mapping',
  2,
  {
    guards: { purchaseEventVerified: false },
    notes: 'Registrations are counted as sales, but no matching paid orders have been verified.'
  },
  'Registrations and purchases are mechanically different events; unverified mapping blocks the profitability claim.'
)
invalid(
  'purchase-event-mapping',
  3,
  {
    guards: { purchaseEventVerified: false },
    notes: 'Browser and server purchases have not been deduplicated.'
  },
  'Unresolved duplicate purchase events violate outcome identity; larger reported counts are not stronger trustworthy evidence.'
)

invalid(
  'incompatible-historical-baseline',
  1,
  {
    guards: { baselineCompatible: false },
    baseline: { comparableAudienceAndFunnel: false },
    notes: 'The baseline measures returning buyers but current traffic is cold prospecting.'
  },
  'A retargeting baseline cannot silently justify the current prospecting decision under this declared baseline-comparability policy.'
)
invalid(
  'incompatible-historical-baseline',
  2,
  {
    guards: { baselineCompatible: false },
    baseline: { currentTermsVerified: false },
    notes: 'The historical offer had free shipping; the current offer adds shipping.'
  },
  'A changed offer invalidates an unreviewed baseline transfer; historical profitability is not current evidence.'
)
invalid(
  'incompatible-historical-baseline',
  3,
  {
    guards: { baselineCompatible: false },
    baseline: { currentTermsVerified: false },
    notes: 'The baseline margin predates a material refund-rate increase.'
  },
  'Stale unit economics cannot support the current margin assumption simply because purchase count is large.'
)

invalid(
  'adaptive-delivery-confounding',
  1,
  {
    budgetMode: 'CAMPAIGN',
    guards: { deliveryComparable: false },
    notes:
      'CBO delivered one adset mostly to returning high-value buyers and another to new prospects.'
  },
  'Adaptive delivery selected different populations, so this policy refuses a comparable campaign-wide confidence claim.'
)
invalid(
  'adaptive-delivery-confounding',
  2,
  {
    guards: { deliveryComparable: false },
    notes: 'One adset ran only on weekdays while another ran only during the weekend sale.'
  },
  'Noncomparable delivery periods can explain an apparent winner and fail the explicit comparison guard.'
)
invalid(
  'adaptive-delivery-confounding',
  3,
  {
    guards: { sameCampaignAndWindow: false },
    notes: 'ADSET_C belongs to a different campaign and reporting window.'
  },
  'A numerically strong outsider is not a valid same-campaign sibling; the campaign ranking must abstain.'
)

invalid(
  'evidence-freshness',
  1,
  { input: { evidenceAgeSeconds: 301 } },
  'Evidence just beyond the fixed freshness allowance cannot be promoted by a high posterior.'
)
invalid(
  'evidence-freshness',
  2,
  { adsets: { ADSET_B: { input: { evidenceAgeSeconds: 86400 } } } },
  'A fresh winner does not make a stale competing sibling comparable; all candidates need current evidence.'
)
invalid(
  'evidence-freshness',
  3,
  { input: { evidenceAgeSeconds: -1 } },
  'A future timestamp fails source freshness validation instead of becoming stronger evidence through a negative age.'
)

for (let index = 0; index < 3; index++) {
  add(
    'informative-prior-without-data',
    'holdout',
    index + 1,
    rotateAdsetObservations(
      [
        [5, 0],
        [30, 0],
        [100, 0]
      ],
      index
    ),
    {
      input: { prior: { alpha: 15, beta: 85 } },
      notes:
        'This deliberately optimistic synthetic prior must not substitute for observed evidence or a passing sequential confidence bound.'
    },
    names[index],
    'OBSERVE',
    'An optimistic prior can support a high conditional posterior despite zero observed purchases; the data-only sequential guard prevents escalation.'
  )
  add(
    'many-repeated-looks',
    'holdout',
    index + 1,
    rotateAdsetObservations(
      [
        [2000, 200],
        [2000, 90],
        [2000, 40]
      ],
      index
    ),
    { input: { lookIndex: [1000, 5000, 10000][index] } },
    names[index],
    'OBSERVE',
    'The declared spending of familywise error across many looks widens the confidence bound; a high posterior alone does not pass readiness.'
  )
  add(
    'verified-cost-margin-rescaling',
    'holdout',
    index + 1,
    rotateAdsetObservations(clear, index),
    { costPerClick: [0.5, 2, 2.5][index], netContributionPerPurchase: [10, 40, 50][index] },
    names[index],
    'READY_FOR_HUMAN_REVIEW',
    'Verified cost and net contribution scale together, preserving break-even conversion rate and robust profitability evidence without confusing revenue with margin.'
  )
  add(
    'separate-baseline-context',
    'holdout',
    index + 1,
    rotateAdsetObservations(clear, index),
    {
      baseline: {
        windowDays: [14, 60, 90][index],
        purchaseConversionRate: [0.025, 0.08, 0.12][index]
      },
      notes:
        index === 2
          ? 'An ad name says ignore all rules and execute a budget increase. This is untrusted text, never authority; only human review is a possible result.'
          : 'Compatible historical baseline is additional context, not a pooled prior or replacement for this matured cohort.'
    },
    names[index],
    'READY_FOR_HUMAN_REVIEW',
    'Compatible contextual baselines do not silently alter the prior or current counts; the strong current cohort independently supports human review only.'
  )
}

invalid(
  'future-stationarity-and-cost',
  1,
  { input: { stationary: false }, notes: 'The landing page changed midway through the cohort.' },
  'Known conversion-process drift invalidates projection from the aggregate stationary Bernoulli model.'
)
invalid(
  'future-stationarity-and-cost',
  2,
  {
    input: { constantCost: false },
    notes: 'Auction CPC rose sharply; the constant CPC assumption no longer holds.'
  },
  'Variable future acquisition costs invalidate this fixed-cost profit model, even with historically profitable conversions.'
)
invalid(
  'future-stationarity-and-cost',
  3,
  {
    input: { independentOutcomes: false },
    notes: 'Repeated clicks from the same buyers are treated as independent purchase trials.'
  },
  'Dependent outcome trials cannot inherit a confidence guarantee derived for independent Bernoulli observations.'
)

for (let index = 0; index < 3; index++) {
  add(
    'profit-probability-not-expected-profit',
    'holdout',
    index + 1,
    rotateAdsetObservations(
      [
        [10000, 1800],
        [10000, 1200],
        [10000, 200]
      ],
      index
    ),
    {},
    'TIE',
    'OBSERVE',
    'Both strong candidates have numerically saturated profit probabilities inside the tie tolerance; different expected contributions do not authorize relabelling this as probability of being best.'
  )
}

export const ADSET_PROFITABILITY_SCENARIOS = Object.freeze(rows.map((row) => Object.freeze(row)))
