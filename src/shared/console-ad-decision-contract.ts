import { z } from 'zod'
import { optionalText } from './console-advertising-leaves'

// ── GET /api/gtd/hub/api/adops/instances/{id}/decision ─────────────────────────
/**
 * A figure that may legitimately be negative: a profit, a ROAS, a contribution.
 */
const decisionMoney = z.number().finite().nullable().optional().default(null)
/**
 * A figure that cannot be negative without the payload being wrong: spend, a cost per
 * result, an exposure, a CPM. The original contract guards these separately and so does
 * this one — collapsing the two let a `spend: -12.5` parse and render as a fact, and a
 * negative spend shown as a measurement is worse than a refused payload.
 */
const decisionNonNegative = z.number().finite().nonnegative().nullable().optional().default(null)
const decisionCount = z.number().finite().int().nonnegative().nullable().optional().default(null)
const decisionTime = z.string().nullable().optional().default(null)
const probability = z.number().finite().min(0).max(1)
/** Two endpoints, or the estimator's explicit "not enough evidence". */
const credibleInterval = z
  .union([
    z
      .tuple([probability, probability])
      .refine(([low, high]) => low <= high, 'Probability interval is reversed'),
    z.tuple([z.null(), z.null()]).transform(() => null)
  ])
  .nullable()
  .optional()
  .default(null)

export const DECISION_SECTIONS = ['overview', 'decisions', 'cbo', 'statistics'] as const
export type DecisionSection = (typeof DECISION_SECTIONS)[number]
export const decisionSection = z.enum(DECISION_SECTIONS)

const decisionWindowMetrics = z
  .object({
    spend: decisionNonNegative,
    cpm: decisionNonNegative,
    link_ctr: decisionNonNegative,
    impressions: decisionCount,
    link_clicks: decisionCount,
    link_cpc: decisionNonNegative,
    leads: decisionCount,
    lead_cpl: decisionNonNegative,
    registrations: decisionCount,
    registration_cpl: decisionNonNegative,
    checkouts: decisionCount,
    purchases: decisionCount,
    purchase_cpa: decisionNonNegative,
    attributed_revenue: decisionMoney,
    matched_revenue: decisionMoney,
    roas: decisionMoney,
    contribution_profit: decisionMoney,
    contribution_roi: decisionMoney,
    active_budget_exposure: decisionNonNegative,
    costs_known: z.boolean().nullable().optional().default(null),
    revenue_basis: optionalText,
    observed_at: decisionTime,
    source: optionalText
  })
  .passthrough()
const decisionWindow = z.object({ start: optionalText, end: optionalText }).passthrough()

export const advertisingDecisionRow = z
  .object({
    id: z.string().min(1),
    object_id: optionalText,
    name: z.string().optional().default('Unnamed object'),
    level: optionalText,
    segment: optionalText,
    campaign_id: optionalText,
    campaign_name: optionalText,
    adset_id: optionalText,
    adset_name: optionalText,
    action: z.string().min(1),
    reason: z.string().optional().default('Reason not reported'),
    basis: z
      .enum([
        'approved_rule',
        'acquisition_target',
        'economic_estimate',
        'calibrated_model',
        'operator_policy_proposal',
        'apexlabs_recommendation',
        'unknown'
      ])
      .optional()
      .default('unknown'),
    uncertainty: z.array(z.string()).optional().default([]),
    status: optionalText,
    /** Estimated, never asserted: the view shows it only beside its calibration. */
    probability: probability.nullable().optional().default(null),
    credible_interval: credibleInterval,
    calibration_status: z
      .enum(['uncalibrated', 'provisional', 'calibrated'])
      .nullable()
      .optional()
      .default(null),
    expected_benefit: optionalText,
    expected_additional_contribution: decisionMoney,
    downside_exposure: decisionNonNegative,
    blockers: z.array(z.string()).optional().default([]),
    observed_at: decisionTime,
    evidence_revision: optionalText,
    today: decisionWindowMetrics.nullable().optional().default(null),
    seven: decisionWindowMetrics.nullable().optional().default(null)
  })
  .passthrough()

export const advertisingDecision = z
  .object({
    schema_version: z.literal(1),
    company: z.string().min(1),
    account_id: optionalText,
    collections: z
      .object({
        decisions: z.object({ total: z.number().int().nonnegative() }),
        cbo_campaigns: z.object({ total: z.number().int().nonnegative() }),
        statistics: z.object({ available: z.boolean() })
      })
      .optional(),
    pagination: z
      .object({
        section: decisionSection,
        offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(20),
        total: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        has_more: z.boolean(),
        campaign_id: optionalText
      })
      .optional(),
    operation: z
      .object({
        mode: z.enum(['auto', 'recommend', 'paused', 'unconfigured']),
        status: z.string().min(1),
        account_state: z
          .enum(['ARMED', 'SLEEPING', 'OPERATOR_PAUSED'])
          .nullable()
          .optional()
          .default(null),
        interval_minutes: z.number().int().positive().nullable().optional().default(null),
        last_evaluated_at: decisionTime,
        last_successful_evaluation_at: decisionTime,
        next_due_at: decisionTime,
        /** How old the provider observation behind this answer is. */
        insights_age_seconds: z.number().finite().nonnegative().nullable().optional().default(null),
        insights_observed_at: decisionTime,
        spend_observed_at: decisionTime,
        fact_coverage_complete: z.boolean().nullable().optional().default(null),
        coverage: z
          .object({
            evaluated: decisionCount,
            active: decisionCount,
            paused: decisionCount,
            complete: z.boolean().nullable().optional().default(null),
            campaigns: decisionCount,
            adsets: decisionCount,
            ads: decisionCount
          })
          .passthrough(),
        errors: z.array(z.string()).optional().default([])
      })
      .passthrough(),
    windows: z
      .object({
        timezone: optionalText,
        today: decisionWindow,
        seven: decisionWindow
      })
      .passthrough(),
    money: z
      .object({
        spend_today: decisionMoney,
        attributed_revenue_today: decisionMoney,
        collected_revenue_today: decisionMoney,
        matched_revenue_today: decisionMoney,
        /** Active budget is an allowance, never spend and never revenue. */
        active_daily_budget: decisionMoney,
        spending_limit_remaining: decisionMoney,
        operating_remaining: decisionMoney,
        currency: optionalText,
        costs_known: z.boolean().nullable().optional().default(null)
      })
      .passthrough(),
    statistics: z
      .object({
        complete: z.boolean().nullable().optional().default(null),
        observed_at: decisionTime,
        timezone: z.string().nullable().optional(),
        currency: z.string().nullable().optional(),
        observation_age_seconds: z.number().finite().nonnegative().nullable().optional(),
        limitations: z.array(z.string()).optional().default([]),
        account: z
          .object({
            today: decisionWindowMetrics.nullable().optional().default(null),
            seven: decisionWindowMetrics.nullable().optional().default(null)
          })
          .passthrough()
      })
      .passthrough()
      .nullable()
      .optional()
      .default(null),
    // Required, as in the original: a payload with no `decisions` key is malformed, and
    // defaulting it to `[]` made that indistinguishable from a cycle that decided nothing.
    decisions: z.array(advertisingDecisionRow),
    // Optional with no default, also as in the original: absent stays absent.
    next_actions: z.array(advertisingDecisionRow).optional(),
    policy: z
      .object({
        probability_model_calibrated: z.boolean().nullable().optional().default(null)
      })
      .passthrough(),
    evidence_revision: optionalText
  })
  .passthrough()

export type AdvertisingDecisionRow = z.infer<typeof advertisingDecisionRow>
export type AdvertisingDecision = z.infer<typeof advertisingDecision>
export type AdvertisingDecisionMetrics = z.infer<typeof decisionWindowMetrics>
