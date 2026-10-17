import { z } from 'zod'
import { instant, nonNegativeCount, optionalText } from './console-advertising-leaves'

// ── GET /api/gtd/hub/api/adops/webinarjam/summary ─────────────────────────────
export const WEBINAR_WINDOWS = ['today', 'd7', 'd30'] as const
export type WebinarWindow = (typeof WEBINAR_WINDOWS)[number]
export const webinarWindow = z.enum(WEBINAR_WINDOWS)
const webinarMetrics = z
  .object({
    registrations: nonNegativeCount,
    attended: nonNegativeCount,
    attended_live: nonNegativeCount,
    attended_replay: nonNegativeCount,
    attendance_rate: z.number().min(0).max(1).nullable(),
    avg_live_watch_seconds: z.number().finite().nonnegative().nullable(),
    live_watch_samples: nonNegativeCount,
    live_watch_missing: nonNegativeCount,
    live_watch_zero: nonNegativeCount,
    watched_full: nonNegativeCount.nullable().optional(),
    watched_rate: z.number().min(0).max(1).nullable().optional(),
    completion_known_attendees: nonNegativeCount.optional(),
    completion_unknown_attendees: nonNegativeCount.optional()
  })
  .passthrough()
const webinarGroup = webinarMetrics.extend({
  id: z.string().regex(/^\d+$/),
  name: z.string().trim().min(1).nullable().optional().catch(null)
})
export const webinarSummary = z
  .object({
    company: z.literal('omnirogue'),
    provider: z.string(),
    window: webinarWindow,
    cohort: z
      .object({
        basis: z.string(),
        start: instant,
        end: instant,
        time_zone: z.string(),
        includes_today: z.boolean()
      })
      .passthrough(),
    as_of: instant,
    metrics: webinarMetrics,
    by_adset: z.array(webinarGroup).default([]),
    by_ad: z.array(webinarGroup).default([]),
    attribution: z
      .object({
        adset_mapped_registrations: nonNegativeCount,
        ad_mapped_registrations: nonNegativeCount,
        unattributed_adset_registrations: nonNegativeCount,
        unattributed_ad_registrations: nonNegativeCount,
        unresolved_template_registrations: nonNegativeCount
      })
      .passthrough()
  })
  .passthrough()
/**
 * The consistency the original enforces and this port had dropped: the two completion
 * buckets must account for exactly the attendees, a full-completion count may not exceed
 * the attendees whose completion is known, and a supplied rate must match the figures it
 * claims to summarise.
 *
 * Without it an inconsistent payload renders — a "confirmed full completion" larger than
 * the attendance it came from is a number on screen that cannot be true, and this is the
 * one funnel Sal reads against Meta's own events. Older documents that carry none of the
 * completion fields are still accepted, exactly as the original accepts them.
 */
function completionIsConsistent(metrics: z.infer<typeof webinarMetrics>): boolean {
  const { watched_full: full, watched_rate: rate } = metrics
  const known = metrics.completion_known_attendees
  const unknown = metrics.completion_unknown_attendees
  const attended = metrics.attended
  if ([full, rate, known, unknown].every((field) => field === undefined)) {
    return true
  }
  if (full === undefined || rate === undefined || known === undefined || unknown === undefined) {
    return false
  }
  if (known + unknown !== attended) {
    return false
  }
  if (full !== null && full > known) {
    return false
  }
  const expected = unknown === 0 && attended > 0 && full !== null ? full / attended : null
  return expected === null
    ? rate === null
    : typeof rate === 'number' && Math.abs(rate - expected) < 1e-8
}

export const webinarSummaryChecked = webinarSummary.superRefine((value, context) => {
  for (const metrics of [value.metrics, ...value.by_adset, ...value.by_ad]) {
    if (!completionIsConsistent(metrics)) {
      context.addIssue({
        code: 'custom',
        message: 'Webinar completion counts or their denominator do not match attendance'
      })
      return
    }
  }
})

export const webinarEnvelope = z
  .object({
    status: z.enum(['refreshing', 'ready', 'stale', 'unavailable']),
    refreshing: z.boolean(),
    data: webinarSummaryChecked.nullable()
  })
  .refine(
    (value) => !['ready', 'stale'].includes(value.status) || value.data !== null,
    'A ready webinar answer must carry its summary'
  )

export type WebinarMetrics = z.infer<typeof webinarMetrics>
export type WebinarGroup = z.infer<typeof webinarGroup>
export type WebinarSummary = z.infer<typeof webinarSummary>
export type WebinarEnvelope = z.infer<typeof webinarEnvelope>

/**
 * Confirmed full completion, or null. A nonNegativeCount is only a completion nonNegativeCount when
 * every attendee's completion state is known; otherwise it is a floor, not a fact.
 */
export function confirmedFullCompletion(metrics: WebinarMetrics): number | null {
  return metrics.completion_unknown_attendees === 0 ? (metrics.watched_full ?? null) : null
}

/**
 * A company name reduced for comparison. The coordinator spells a company freely
 * ("OmniRogue", "omnirogue", "omni-rogue"), so a fence that compared the raw strings
 * would let another company's answer through on a spelling difference.
 */
export function normalizeCompany(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ── GET /api/gtd/hub/api/adops ────────────────────────────────────────────────
export const adOpsInstance = z
  .object({
    id: z.string(),
    company: z.string(),
    name: optionalText,
    status: optionalText,
    state: optionalText,
    config: z.record(z.string(), z.unknown()).default({}),
    last_run_at: optionalText,
    next_run_at: optionalText
  })
  .passthrough()
export const adOpsOverview = z
  .object({ instances: z.array(adOpsInstance).default([]) })
  .passthrough()
export type AdOpsInstance = z.infer<typeof adOpsInstance>
export type AdOpsOverview = z.infer<typeof adOpsOverview>

/**
 * The account coordinator for one company, or nothing. A duplicate must never be
 * resolved by array order: the caller shows "coordinator ambiguous" instead.
 */
export function coordinatorInstanceId(overview: AdOpsOverview, company: string): string | null {
  const mine = overview.instances.filter(
    (instance) => normalizeCompany(instance.company) === normalizeCompany(company)
  )
  const coordinators = mine.filter((instance) => {
    if (instance.config.execution_mode === 'account_coordinator') {
      return true
    }
    const nested = instance.config.account_coordinator
    return (
      typeof nested === 'object' &&
      nested !== null &&
      !Array.isArray(nested) &&
      (nested as Record<string, unknown>).enabled === true
    )
  })
  const chosen = coordinators.length > 0 ? coordinators : mine
  return chosen.length === 1 ? chosen[0].id : null
}
