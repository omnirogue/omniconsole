import { z } from 'zod'

// The omnios scorecard's company/domain health, read exactly as the web console
// reads GET /api/gtd/scorecard/attention. Only the judgement, its measurements
// and its evidence links travel to the desktop — the scorecard's customer-email
// subtree is deliberately not mirrored here.

const text = z.string().nullable().optional()
const nullableNumber = z.number().finite().nullable().optional()
const healthStatus = z
  .enum(['healthy', 'warning', 'critical', 'unknown', 'unconfigured'])
  .catch('unknown')
const coverage = z.object({ state: z.string(), detail: z.string() })
const trend = z.object({ direction: z.string(), delta: nullableNumber, detail: text })
const evidence = z.object({ label: z.string(), href: text, detail: text })
const action = z.object({
  label: z.string(),
  href: text,
  task_id: text,
  status: healthStatus.optional()
})
const metric = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  actual: nullableNumber,
  unit: z.string(),
  status: healthStatus,
  summary: z.string(),
  coverage,
  trend: trend.optional(),
  evidence: z.array(evidence).default([]),
  next_action: action.optional(),
  owner: z.object({ employee_id: text, name: text }).nullable().optional(),
  target: z.object({ label: text }).optional()
})
const change = z.object({ label: z.string(), detail: text, metric_id: text, direction: text })
const domainHealth = z.object({
  id: text,
  parent_unit_id: text,
  kind: z.string(),
  name: z.string(),
  status: healthStatus,
  own_status: healthStatus.optional(),
  href: z.string(),
  summary: z.string().default('Domain summary has not been collected yet.'),
  metrics: z.array(metric).default([]),
  headline_metrics: z.array(metric).default([]),
  changes: z.array(change).default([]),
  actions: z.array(action).default([]),
  work: z
    .object({ active: nullableNumber, blocked: nullableNumber, verified_7d: nullableNumber })
    .optional()
})
const companyHealth = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: healthStatus,
  href: z.string(),
  summary: z.string().default('Company summary has not been collected yet.'),
  domains: z.array(domainHealth),
  headline_metrics: z.array(metric).default([]),
  changes: z.array(change).default([]),
  actions: z.array(action).default([]),
  domain_summary: z
    .object({
      healthy: z.number(),
      attention: z.number(),
      unknown: z.number(),
      unconfigured: z.number(),
      total: z.number()
    })
    .optional()
})
export const companyHealthView = z.object({
  generated_at: z.string(),
  timezone: z.string(),
  companies: z.array(companyHealth)
})

export type HealthStatus = z.infer<typeof healthStatus>
export type HealthMetric = z.infer<typeof metric>
export type HealthAction = z.infer<typeof action>
export type HealthChange = z.infer<typeof change>
export type HealthEvidence = z.infer<typeof evidence>
export type DomainHealth = z.infer<typeof domainHealth>
export type CompanyHealth = z.infer<typeof companyHealth>
export type CompanyHealthView = z.infer<typeof companyHealthView>

/** Companies the omnios scorecard collects a standard for. */
export const HEALTH_COMPANY_SLUGS = ['acme', 'omnirogue', 'betacorp'] as const
export function hasCompanyHealth(slug: string): boolean {
  return HEALTH_COMPANY_SLUGS.some((value) => value === slug)
}

/** Only in-app links or plain HTTPS evidence. Never follow a source-provided scheme. */
export function healthHref(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  if ([...value].some((character) => character.charCodeAt(0) <= 32 || character === '\\')) {
    return null
  }
  if (value.startsWith('#') || /^\/(?![\\/])/.test(value)) {
    return value
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch {
    return null
  }
}

/** The scorecard's domain families, as the web console maps a department name. */
export function domainFamily(name: string | null | undefined): string | undefined {
  const value = (name ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (['customerservice', 'support'].includes(value)) {
    return 'customer_service'
  }
  if (['development', 'engineering'].includes(value)) {
    return 'engineering'
  }
  if (['sales', 'marketing', 'advertising', 'creative', 'creatives'].includes(value)) {
    return 'advertising'
  }
  if (['finance', 'financeadmin', 'admin', 'accounting'].includes(value)) {
    return 'finance'
  }
  if (['operations', 'ops'].includes(value)) {
    return 'operations'
  }
  return undefined
}

/** Never substitute a sibling unit that happens to share a metric family. */
export function domainForId(
  company: CompanyHealth,
  id: string | null | undefined
): DomainHealth | null {
  return id ? (company.domains.find((domain) => domain.id === id) ?? null) : null
}

export function metricValue(value: HealthMetric): string {
  if (value.actual === null || value.actual === undefined) {
    return '—'
  }
  const amount = value.actual
  if (value.unit === 'usd' || value.unit === 'USD') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(amount)
  }
  if (['hours', 'hour'].includes(value.unit)) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(amount)}h`
  }
  if (['percent', 'percentage', '%'].includes(value.unit)) {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(amount)}%`
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(amount)
}
