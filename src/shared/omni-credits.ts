import { z } from 'zod'

const count = z.number().finite().nonnegative()
const plan = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  monthly_credits: count.optional(),
  price: z.string().optional()
})
const nextPlan = plan.extend({
  contact: z.boolean().optional(),
  interval: z.enum(['month', 'once']).optional(),
  setup_price: z.string().optional()
})
const httpsUrl = z.unknown().transform((value) => {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:' ? value : ''
  } catch {
    return ''
  }
})
const upgrade = z
  .object({
    url: httpsUrl.default(''),
    next_plan: nextPlan.nullish().transform((value) => value ?? null),
    can_upgrade: z.boolean().default(false)
  })
  .default({ url: '', next_plan: null, can_upgrade: false })
const member = z.object({
  actor: z.string().default(''),
  name: z.string().default(''),
  spent: count.optional(),
  email: z.string().optional(),
  you: z.boolean().optional()
})

export const creditWalletSchema = z.object({
  enabled: z.literal(true),
  unit: z.literal('credit').default('credit'),
  balance: count,
  granted: count.optional(),
  spent: count.optional(),
  period: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  plan: plan.optional(),
  low: z.boolean().optional(),
  exhausted: z.boolean().optional(),
  low_threshold: count.optional(),
  you: member.optional(),
  // Presence is the server's authorization to display team usage.
  members: z.array(member).optional(),
  upgrade
})

export type CreditWallet = z.infer<typeof creditWalletSchema>
export const creditsExhaustedSchema = z.object({
  error: z.literal('credits_exhausted'),
  needed: count,
  balance: count,
  period_end: z.string().optional(),
  plan: plan.optional(),
  upgrade
})
export type CreditsExhausted = z.infer<typeof creditsExhaustedSchema>

export function parseCreditWallet(payload: unknown): CreditWallet | null {
  const parsed = creditWalletSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
