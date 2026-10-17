import { z } from 'zod'

export const PTY_AGENT_INTERRUPT_METHOD = 'pty.interruptAgent'
export const ptyAgentInterruptRequest = z
  .object({
    id: z.string().min(1).max(4096),
    incarnationId: z.string().min(1).max(128),
    interruptToken: z.string().uuid()
  })
  .strict()
export const ptyAgentInterruptReply = ptyAgentInterruptRequest.extend({
  outcome: z.enum(['written', 'refused', 'unsupported', 'revoked', 'unknown'])
})
