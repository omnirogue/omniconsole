import { z } from 'zod'
import type { NativeChatMessage, NativeChatTurnLifecycle } from './native-chat-types'

export const SSH_OMP_CHAT_METHOD = 'transcript.readOmpTailV1'
export const SSH_OMP_CHAT_CAPABILITY = 'omp-transcript-tail-v1'
export const sshOmpChatRequest = z
  .object({
    agent: z.literal('omp'),
    sessionId: z.string().min(1).max(512),
    limit: z.number().int().positive().max(2000).default(300)
  })
  .strict()
export type SshOmpChatRequest = z.input<typeof sshOmpChatRequest>
export type SshOmpChatResult =
  | {
      messages: NativeChatMessage[]
      hasMore: boolean
      lifecycle?: NativeChatTurnLifecycle
      model?: string
    }
  | { error: string; notFound?: true }
