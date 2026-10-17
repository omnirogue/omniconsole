import { z } from 'zod'
import { chatRecipient } from './chat-delivery'

export const sessionFollowUpAgentRecipient = chatRecipient.options[1].extend({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
  delivery: z.enum(['pending', 'sending', 'sent', 'failed']),
  messageId: z
    .string()
    .regex(/^pm_[a-f0-9]{24}$/)
    .optional(),
  receiptState: z.string().max(100).optional(),
  error: z.string().max(2000).optional(),
  at: z.number().finite().optional()
})
export type SessionFollowUpAgentRecipient = z.infer<typeof sessionFollowUpAgentRecipient>

export function normalizeFollowUpAgents(value: unknown): SessionFollowUpAgentRecipient[] | null {
  if (value === undefined) {
    return []
  }
  const result = z.array(sessionFollowUpAgentRecipient).max(20).safeParse(value)
  if (
    !result.success ||
    new Set(result.data.map((recipient) => recipient.id)).size !== result.data.length
  ) {
    return null
  }
  return result.data.map((recipient) =>
    recipient.delivery === 'sent' && !recipient.messageId
      ? { ...recipient, delivery: 'sending' }
      : recipient
  )
}
