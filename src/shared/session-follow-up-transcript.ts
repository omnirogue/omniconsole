import { z } from 'zod'
import { normalizeExecutionHostId } from './execution-host'

/** Consent pins a session identity now; its complete public history is read only at completion. */
export const sessionFollowUpTranscriptSource = z
  .object({
    kind: z.enum(['provider', 'structured']),
    hostId: z.string().transform((value, ctx) => {
      const host = normalizeExecutionHostId(value)
      if (!host) {
        ctx.addIssue({ code: 'custom', message: 'The transcript execution host is invalid.' })
        return z.NEVER
      }
      return host
    }),
    runtimeEnvironmentId: z.string().min(1).max(200).optional(),
    agent: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(500),
    transcriptPath: z.string().min(1).max(4096).optional()
  })
  .strict()

export type SessionFollowUpTranscriptSource = z.infer<typeof sessionFollowUpTranscriptSource>
