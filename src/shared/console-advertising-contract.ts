import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'
import { decisionSection, type AdvertisingDecision } from './console-ad-decision-contract'
import { webinarWindow, type AdOpsOverview, type WebinarEnvelope } from './console-adops-contract'
import { dailySalesScope, type DailySalesReport } from './console-daily-sales-contract'
import {
  salesCompany,
  salesLevel,
  salesRangeDays,
  salesState,
  type SalesAdsReport
} from './console-sales-ads-contract'

/**
 * The desktop's READ-ONLY advertising surface, decoded exactly as the OmniOS
 * console decodes the same hub answers. The shapes live in four neighbours, one
 * per hub read; this file is the door they are reached through.
 *
 * Three rules those files exist to keep:
 *  - A missing measure is `null`, never zero. Every cost-per figure is derived from
 *    the displayed numerator and denominator, so a zero-count object shows no cost
 *    rather than a free one.
 *  - Actual spend, active budget, Meta-attributed revenue and Stripe cash are
 *    four different facts and never add together.
 *  - No write lives here. Pausing, budgets, coordinator edits, connection setup
 *    and sync each need their own reviewed operation; a read contract is not a door.
 */

export { unitCost } from './console-advertising-leaves'
export * from './console-sales-ads-contract'
export * from './console-daily-sales-contract'
export * from './console-adops-contract'
export * from './console-ad-decision-contract'

// ── request shapes, validated in main before a URL is built ───────────────────
export const salesAdsRequest = z
  .object({
    company: salesCompany,
    rangeDays: salesRangeDays,
    level: salesLevel,
    state: salesState
  })
  .strict()
export const dailySalesRequest = z
  .object({ scope: dailySalesScope, rangeDays: salesRangeDays, sameTime: z.boolean() })
  .strict()
export const webinarRequest = z.object({ window: webinarWindow }).strict()
export const decisionRequest = z
  .object({
    instanceId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    section: decisionSection,
    offset: z.number().int().min(0).max(10_000),
    // The coordinator's own page maximum; a larger ask is refused here, not there.
    limit: z.number().int().min(1).max(20),
    campaignId: z
      .string()
      .regex(/^[0-9]{5,30}$/)
      .optional()
  })
  .strict()
  .refine((value) => value.campaignId === undefined || value.section !== 'overview', {
    message: 'Campaign filtering requires a paginated evidence section.'
  })

/**
 * Reads only, one operation per view need. Every call is signed in the main
 * process with the person who is signed in to omnios; the BFF stays the identity,
 * company-scope and audit authority, and refuses exactly as it refuses the web app.
 */
export type ConsoleAdvertisingApi = {
  salesAds: (
    args: z.infer<typeof salesAdsRequest>
  ) => Promise<ConsoleWorkflowResult<SalesAdsReport>>
  dailySales: (
    args: z.infer<typeof dailySalesRequest>
  ) => Promise<ConsoleWorkflowResult<DailySalesReport>>
  webinar: (args: z.infer<typeof webinarRequest>) => Promise<ConsoleWorkflowResult<WebinarEnvelope>>
  adOps: () => Promise<ConsoleWorkflowResult<AdOpsOverview>>
  decision: (
    args: z.infer<typeof decisionRequest>
  ) => Promise<ConsoleWorkflowResult<AdvertisingDecision>>
}
