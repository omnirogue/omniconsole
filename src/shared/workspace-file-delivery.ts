import { z } from 'zod'
import { consoleConversationSourcePath } from './console-conversation-source-files'

export const workspaceFileDeliveryRequest = z
  .object({
    worktree: z.string().min(1).max(4096),
    sourcePath: consoleConversationSourcePath,
    expectedSourceHostId: z.string().regex(/^(local|ssh:[^\s]+)$/),
    recipientRuntimeId: z.string().uuid(),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    destination: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('desktop'), name: z.string().min(1).max(255) }).strict(),
      z.object({ kind: z.literal('path'), path: z.string().min(1).max(4096) }).strict()
    ])
  })
  .strict()

export type WorkspaceFileDeliveryRequest = z.infer<typeof workspaceFileDeliveryRequest>

export type WorkspaceFileDeliveryResult = {
  disposition: 'delivered' | 'already-present'
  source: { hostId: string; worktreeId: string; path: string }
  recipient: { runtimeId: string; hostname: string; path: string }
  size: number
  sha256: string
}
