import {
  adOpsOverview,
  advertisingDecision,
  dailySalesReport,
  dailySalesRequest,
  decisionRequest,
  salesAdsReport,
  salesAdsRequest,
  webinarEnvelope,
  webinarRequest,
  type ConsoleAdvertisingApi
} from '../../shared/console-advertising-contract'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

/**
 * Sal's advertising reads, through the desktop's signed backoffice transport.
 *
 * Every operation is a GET. The route allowlist in `console-workflow-routes.ts`
 * only permits the exact query shapes built here, so the query string is
 * assembled in a fixed key order rather than by a URLSearchParams walk whose
 * ordering would drift and be refused.
 *
 * Each response is re-checked against the scope that was asked for: a cache or
 * routing mix-up must never paint another company's or another window's money.
 */
export const consoleAdvertisingClient: ConsoleAdvertisingApi = {
  salesAds: (args) =>
    validated(args, salesAdsRequest, (input) =>
      request(
        `/api/gtd/hub/api/sales/ads?company=${input.company}&range_days=${input.rangeDays}&level=${input.level}&state=${input.state}`,
        'GET',
        salesAdsReport
          .refine(
            (value) => value.company === input.company,
            'This advertising report belongs to a different company.'
          )
          // Why: a level mix-up silently adds a campaign to its own ad sets.
          .refine(
            (value) => value.rows.every((row) => row.level === input.level),
            'This advertising report mixes object levels.'
          ),
        undefined,
        // The BFF allows 40s for the hub's paginated provider reads.
        45_000
      )
    ),
  dailySales: (args) =>
    validated(args, dailySalesRequest, (input) =>
      request(
        `/api/gtd/hub/api/sales/daily?company=${input.scope}&range_days=${input.rangeDays}&same_time=${String(input.sameTime)}`,
        'GET',
        dailySalesReport
          .refine(
            (value) => value.company === input.scope,
            'This daily Sales report belongs to a different company scope.'
          )
          // The console keeps the same rule: a comparison with no today or no
          // yesterday is not a comparison.
          .refine(
            (value) =>
              value.periods.some((period) => period.key === 'today') &&
              value.periods.some((period) => period.key === 'yesterday'),
            'This daily comparison is incomplete.'
          )
          .refine(
            (value) =>
              new Set(value.periods.map((period) => period.key)).size === value.periods.length,
            'This daily comparison repeats a period.'
          )
      )
    ),
  webinar: (args) =>
    validated(args, webinarRequest, (input) =>
      request(
        `/api/gtd/hub/api/adops/webinarjam/summary?company=omnirogue&window=${input.window}`,
        'GET',
        webinarEnvelope.refine(
          (value) => value.data === null || value.data.window === input.window,
          'This webinar summary covers a different date window.'
        )
      )
    ),
  adOps: () => request('/api/gtd/hub/api/adops', 'GET', adOpsOverview),
  decision: (args) =>
    validated(args, decisionRequest, (input) => {
      const page =
        input.section === 'overview' ? '' : `&offset=${input.offset}&limit=${input.limit}`
      const campaign = input.campaignId === undefined ? '' : `&campaign_id=${input.campaignId}`
      return request(
        `/api/gtd/hub/api/adops/instances/${encodeURIComponent(input.instanceId)}/decision?section=${input.section}${page}${campaign}`,
        'GET',
        advertisingDecision.refine((value) => {
          // Why: an evidence page from another section or offset would be read as
          // this one's, and the operator would act on rows they never asked to see.
          const pagination = value.pagination
          if (!pagination) {
            return input.campaignId === undefined
          }
          if (
            pagination.section !== input.section ||
            pagination.campaign_id !== (input.campaignId ?? null)
          ) {
            return false
          }
          return (
            input.section === 'overview' ||
            (pagination.offset === input.offset && pagination.limit === input.limit)
          )
        }, 'The coordinator returned a different evidence page; refresh before using it.')
      )
    })
}
