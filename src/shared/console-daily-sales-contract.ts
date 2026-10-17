import { z } from 'zod'
import { optionalText } from './console-advertising-leaves'
import { salesCompany } from './console-sales-ads-contract'

// ── GET /api/gtd/hub/api/sales/daily ──────────────────────────────────────────
export const DAILY_SALES_SCOPES = ['omnirogue', 'betacorp', 'all'] as const
export type DailySalesScope = (typeof DAILY_SALES_SCOPES)[number]
export const dailySalesScope = z.enum(DAILY_SALES_SCOPES)
export const SALES_METRIC_NAMES = [
  'sessions',
  'users',
  'impressions',
  'clicks',
  'spend',
  'signups',
  'purchases',
  'new_customer_revenue',
  'renewals',
  'refunds',
  'net_revenue',
  'attributed_revenue',
  'platform_conversion_value',
  'variable_costs',
  'contribution',
  'cac',
  'cpa',
  'roas',
  'attribution_coverage'
] as const
export type SalesMetricName = (typeof SALES_METRIC_NAMES)[number]
const dailyMetric = z.number().finite().nullable().default(null)
const dailyMetrics = z
  .object(
    Object.fromEntries(SALES_METRIC_NAMES.map((key) => [key, dailyMetric])) as Record<
      SalesMetricName,
      typeof dailyMetric
    >
  )
  .passthrough()
  // Why prefault, not default: every inner field already defaults to null, so an
  // absent metrics object parses as "nothing reported" rather than failing.
  .prefault({})

const dailySource = z
  .object({
    source: z.string(),
    provider: optionalText,
    status: z.string(),
    last_collected_at: optionalText,
    last_success_at: optionalText,
    reporting_lag: z.union([z.string(), z.number()]).nullable().default(null),
    error: optionalText,
    timezone: optionalText,
    currency: optionalText,
    alignment: optionalText
  })
  .passthrough()
const dailyChannel = z
  .object({
    channel: z.string(),
    label: z.string(),
    metrics: dailyMetrics,
    status: z.string(),
    notes: z.array(z.string()).default([])
  })
  .passthrough()
const dailyPeriod = z
  .object({
    key: z.enum(['today', 'yesterday', 'selected']),
    label: z.string(),
    date_start: z.string(),
    date_stop: z.string(),
    start_at: z.string(),
    end_at: z.string(),
    partial: z.boolean(),
    currency: optionalText,
    metrics: dailyMetrics,
    channels: z.array(dailyChannel).default([]),
    sources: z.array(dailySource).default([]),
    notes: z.array(z.string()).default([])
  })
  .passthrough()
const dailyConnection = z
  .object({
    company: salesCompany,
    provider: z.enum(['meta', 'google', 'chatgpt']),
    account_id: optionalText,
    account_name: optionalText,
    transport: optionalText,
    authorization: z.string(),
    reporting: z.string(),
    tracking: z.string(),
    mutation_permission: z.string(),
    capabilities: z.array(z.string()).default([]),
    last_test_at: optionalText,
    last_success_at: optionalText,
    error: optionalText,
    next_action: optionalText
  })
  .passthrough()

export const dailySalesReport = z
  .object({
    schema_version: z.literal(1),
    company: dailySalesScope,
    timezone: z.string(),
    generated_at: z.string(),
    periods: z.array(dailyPeriod),
    companies: z.array(z.string()),
    connections: z.array(dailyConnection).default([]),
    definitions: z
      .array(z.object({ metric: z.string(), label: z.string(), description: z.string() }))
      .default([]),
    routine: z
      .object({
        state: z.string(),
        last_success_at: optionalText,
        next_run_at: optionalText,
        interval_minutes: dailyMetric
      })
      .passthrough()
      .nullable()
      .default(null)
  })
  // Why: campaigns/recommendations are large and the ads report already carries the
  // per-object truth; dropping them here keeps this read inside the 2 MiB ceiling.
  .passthrough()

export type DailySalesPeriod = z.infer<typeof dailyPeriod>
export type DailySalesConnection = z.infer<typeof dailyConnection>
export type DailySalesReport = z.infer<typeof dailySalesReport>

export const DAILY_CURRENCY_METRICS: readonly SalesMetricName[] = [
  'spend',
  'new_customer_revenue',
  'renewals',
  'refunds',
  'net_revenue',
  'attributed_revenue',
  'platform_conversion_value',
  'variable_costs',
  'contribution',
  'cac',
  'cpa'
]
