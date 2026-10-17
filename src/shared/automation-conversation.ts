import { z } from 'zod'

export const automationConversationSchema = z.object({
  tabId: z.string().min(1),
  paneKey: z.string().nullable(),
  sessionKey: z.string().nullable().optional()
})
export type AutomationConversation = z.infer<typeof automationConversationSchema>
export type AutomationConversationFields = {
  conversation?: AutomationConversation | null
  createdFromSession?: AutomationConversation | null
}
