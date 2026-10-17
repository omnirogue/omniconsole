import { z } from 'zod'
import { consoleConversationSourcePath } from './console-conversation-source-files'

export const conversationHandoffOutput = z
  .object({
    path: consoleConversationSourcePath,
    source: z.enum(['response', 'manifest'])
  })
  .strict()

export const conversationHandoffReport = z
  .object({
    path: z.literal('handoff-result.json'),
    format: z.literal('json'),
    max_bytes: z.literal(50_331_648),
    files: z.array(consoleConversationSourcePath).max(32),
    manifests: z.array(consoleConversationSourcePath).max(32),
    outputs: z.array(conversationHandoffOutput).max(32)
  })
  .strict()
  .refine((value) => value.files.length + value.manifests.length <= 32)

export type ConsoleConversationHandoffReport = z.infer<typeof conversationHandoffReport>
export type ConsoleConversationHandoffOutput = z.infer<typeof conversationHandoffOutput>
