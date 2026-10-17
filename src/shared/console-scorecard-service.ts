import { z } from 'zod'
import {
  coercedText,
  countOrZero,
  looseCount,
  looseLabel,
  looseNumber,
  looseText,
  scorecardSource
} from './console-scorecard-leaves'

/**
 * Customer service: received → replied → backlog → response times → sentiment →
 * conversations.
 *
 * Sentiment carries its own method and sample size because it is a measurement,
 * not a verdict: the collector computes it from triage categories and a keyword
 * scan over non-spam tickets, and a percentage with no sample behind it is not
 * shown at all.
 */

export const csWindow = z
  .object({
    created: looseCount,
    replied: looseCount,
    closed: looseCount,
    needs_human: looseCount,
    spam: looseCount,
    open: looseCount
  })
  .passthrough()

export const csSentiment = z
  .object({
    /** How the mood was measured, in words. Shown beside every percentage. */
    method: z.string().default(''),
    window_days: looseCount,
    sample: looseCount,
    negative: looseCount,
    positive: looseCount,
    neutral: looseCount,
    negative_pct: looseNumber,
    positive_pct: looseNumber,
    categories: z.array(z.object({ name: z.string(), n: countOrZero }).passthrough()).default([]),
    trustpilot: z
      .object({ reviews_30d: looseCount, avg_rating: looseNumber })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough()

export const csPersonRow = z
  .object({
    actor: z.string(),
    sends: looseCount,
    tickets_touched: looseCount,
    last_send: looseText
  })
  .passthrough()

export const csDetail = z
  .object({
    replied_7d: looseCount,
    response_hours_avg: looseNumber,
    response_hours_median: looseNumber,
    resolved_7d: looseCount,
    resolution_hours_avg: looseNumber,
    complaints: looseCount,
    feature_requests: looseCount
  })
  .passthrough()

export const csTicket = z
  .object({
    // A desk with integer primary keys still has a readable ticket id.
    id: coercedText,
    subject: looseLabel('(no subject)'),
    category: looseText,
    status: looseLabel('unknown'),
    needs_human: z.boolean().default(false),
    replied: z.boolean().default(false),
    created_at: looseText,
    requester_name: looseText
  })
  .passthrough()

export const csCompany = z
  .object({
    slug: looseText,
    division: looseText,
    today: csWindow.optional(),
    week: csWindow.optional(),
    backlog: z
      .object({ open_now: looseCount, needs_human_now: looseCount, oldest_open: looseText })
      .passthrough()
      .optional(),
    people: z.array(csPersonRow).default([]),
    automation: z
      .object({ machine_sends: looseCount, human_sends: looseCount })
      .passthrough()
      .optional(),
    /** Null when this company has no desk at all, which is not the same as a quiet desk. */
    desk: z
      .object({
        configured: z.boolean().default(false),
        reachable: z.boolean().default(false),
        agents: z.array(z.string()).default([])
      })
      .passthrough()
      .nullable()
      .optional(),
    sentiment: csSentiment.nullable().optional(),
    detail: csDetail.nullable().optional(),
    /** The newest non-spam conversations, newest first. */
    recent_tickets: z.array(csTicket).default([]),
    sources: z.array(scorecardSource).optional()
  })
  .passthrough()

export const portfolioCsWindow = z
  .object({
    created: looseCount,
    replied: looseCount,
    spam: looseCount,
    unanswered: looseCount,
    needs_human: looseCount,
    closed: looseCount
  })
  .passthrough()

export const portfolioCustomerService = z
  .object({
    today: portfolioCsWindow.optional(),
    week: portfolioCsWindow.optional(),
    backlog_open_now: looseCount,
    needs_human_now: looseCount,
    response_hours_avg: looseNumber,
    sentiment: z
      .object({
        sample: looseCount,
        negative_pct: looseNumber,
        positive_pct: looseNumber,
        top_categories: z
          .array(z.object({ name: z.string(), n: countOrZero }).passthrough())
          .default([])
      })
      .passthrough()
      .nullable()
      .optional(),
    complaints_7d: looseCount,
    feature_requests_7d: looseCount
  })
  .passthrough()

export type CsWindow = z.infer<typeof csWindow>
export type CsSentiment = z.infer<typeof csSentiment>
export type CsPersonRow = z.infer<typeof csPersonRow>
export type CsDetail = z.infer<typeof csDetail>
export type CsTicket = z.infer<typeof csTicket>
export type CsCompany = z.infer<typeof csCompany>
export type PortfolioCustomerService = z.infer<typeof portfolioCustomerService>

/**
 * Tickets that arrived and nobody answered. Derived rather than read, because the
 * collector reports what it counted: created, replied, spam. It is unknown unless
 * all three were counted, and never negative.
 */
export function unansweredToday(window: CsWindow | null | undefined): number | null {
  const created = window?.created
  const replied = window?.replied
  const spam = window?.spam
  if ([created, replied, spam].some((value) => typeof value !== 'number')) {
    return null
  }
  return Math.max(0, (created as number) - (replied as number) - (spam as number))
}

/** At or above this share of negative tickets, the desk needs looking at. */
export const NEGATIVE_SENTIMENT_WARN_PCT = 40

/** True when this company has a desk the console can read at all. */
export function hasDesk(company: CsCompany | null | undefined): boolean {
  return company?.desk?.configured === true
}
