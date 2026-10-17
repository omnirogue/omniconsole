import { z } from 'zod'
import type { DiscoverCreditBudgetGuard, DiscoverCreditQuote } from './omnirogue-account'
import { DISCOVER_LENS_IDS, DISCOVER_MAX_AGENTS_CEILING } from './local-workflow-draft'

export const DISCOVER_CREDIT_QUOTE_CHANNEL = 'workflowScript:quoteDiscoverCredits'

const credits = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER)
export const discoverCreditPricingSchema = z
  .object({
    creditsPerAgent: credits,
    maxCreditsPerAgent: credits,
    quickMaxCreditsPerAgent: credits.optional()
  })
  .strict()

export const discoverCreditQuoteRequestSchema = z
  .object({
    mode: z.enum(['quick', 'standard', 'deep']),
    pricing: discoverCreditPricingSchema.optional(),
    maxAgents: z.number().int().min(2).max(DISCOVER_MAX_AGENTS_CEILING).optional(),
    lensCount: z.number().int().min(1).max(DISCOVER_LENS_IDS.length).optional(),
    agentCalls: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

export type DiscoverCreditPricing = z.infer<typeof discoverCreditPricingSchema>
export type DiscoverCreditQuoteRequest = z.infer<typeof discoverCreditQuoteRequestSchema>
export type DiscoverCreditQuoteResult = {
  quote: DiscoverCreditQuote | null
  guard: DiscoverCreditBudgetGuard | null
  unavailableReason?: string
}
