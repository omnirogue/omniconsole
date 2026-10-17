import { z } from 'zod'
import { terminalAgentProcessProofSchema } from './pty-agent-process-evidence'

/** Separate method: old hosts must refuse instead of discarding the receiver guard. */
export const SESSION_CONTEXT_ENQUEUE_RPC = 'promptQueue.enqueueContext'

export const sessionContextQueueIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('structured'), sessionId: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal('pty'),
      agent: z.string().min(1).max(64),
      providerSession: z
        .object({
          key: z.enum(['session_id', 'conversation_id']),
          id: z.string().min(1).max(512)
        })
        .strict()
    })
    .strict()
])

// An interrupt ticket is short lived and never belongs in durable queue state.
export const sessionContextProcessSchema = terminalAgentProcessProofSchema.omit({
  interruptToken: true
})

const sessionContextQueueOriginSchema = z
  .object({
    kind: z.literal('session-context'),
    identity: sessionContextQueueIdentitySchema,
    process: sessionContextProcessSchema.optional()
  })
  .refine((origin) => (origin.identity.kind === 'pty') === Boolean(origin.process))

export type SessionContextQueueIdentity = z.infer<typeof sessionContextQueueIdentitySchema>
export type SessionContextQueueOrigin = z.infer<typeof sessionContextQueueOriginSchema>

/** Unknown origins are dropped by older queue readers, never downgraded to unguarded prompts. */
export function normalizeSessionContextQueueOrigin(raw: unknown): SessionContextQueueOrigin | null {
  const parsed = sessionContextQueueOriginSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function sameSessionContextQueueIdentity(
  left: SessionContextQueueIdentity,
  right: SessionContextQueueIdentity
): boolean {
  return left.kind === 'structured'
    ? right.kind === 'structured' && left.sessionId === right.sessionId
    : right.kind === 'pty' &&
        left.agent === right.agent &&
        left.providerSession.key === right.providerSession.key &&
        left.providerSession.id === right.providerSession.id
}
