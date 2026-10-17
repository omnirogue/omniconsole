import { z } from 'zod'
import { communicationType } from './communication-type'
import { exactHandoffFile } from './console-handoff-contract'
import { peerMessageThread } from './peer-message-contract'

export const chatAgentRecipient = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(500),
  employeeId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  projectName: z.string().optional(),
  provider: z.string().optional()
})
export type ChatAgentRecipient = z.infer<typeof chatAgentRecipient>

export const chatAgentSend = z
  .object({
    recipientSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    sourceConversationId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
    sourceLabel: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 160),
    message: z
      .string()
      .trim()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).length <= 8192),
    communicationType,
    attachments: z.array(exactHandoffFile).max(32),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/)
  })
  .strict()
export type ChatAgentSend = z.infer<typeof chatAgentSend>
export type ChatAgentReceipt = { messageId: string; recipientSessionId: string; state: string }

export const chatAgentMessageRequest = z
  .object({ messageId: z.string().regex(/^pm_[a-f0-9]{24}$/) })
  .strict()
export type ChatAgentMessageRequest = z.infer<typeof chatAgentMessageRequest>
export const chatAgentMessageDetail = z.object({ thread: peerMessageThread })
export type ChatAgentMessageDetail = z.infer<typeof chatAgentMessageDetail>
export const chatAgentFile = exactHandoffFile
  .omit({ contentBase64: true })
  .extend({
    id: z.string().regex(/^pf_[a-f0-9]{32}$/)
  })
  .strip()
export type ChatAgentFile = z.infer<typeof chatAgentFile>
