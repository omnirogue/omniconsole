import { z } from 'zod'

export const PTY_AGENT_PROCESS_EVIDENCE_METHOD = 'pty.readAgentProcessEvidence'
export const ptyAgentProcessEvidenceRequest = z
  .object({ id: z.string().min(1).max(4096), incarnationId: z.string().min(1).max(128) })
  .strict()

export const terminalAgentProcessProofSchema = z.object({
  ptyId: z.string().min(1).max(4096),
  incarnationId: z.string().min(1).max(128).nullable(),
  rootPid: z.number().int().min(2),
  pid: z.number().int().min(2),
  pgid: z.number().int().min(2),
  startTimeMs: z.number().finite().positive(),
  agent: z.string().min(1).max(64).nullable(),
  via: z.enum(['hook-report', 'command-line']),
  /** Owner-issued, short-lived Ctrl+C ticket; absent on older relays and local proofs. */
  interruptToken: z.string().uuid().optional()
})

/** The execution host's recognized foreground receiver, pinned to one PTY and process birth. */
export type TerminalAgentProcessProof = z.infer<typeof terminalAgentProcessProofSchema>
export const terminalProcessTreeSchema = z.object({
  kind: z.enum(['agent-gone', 'stopped', 'other'])
})
export type TerminalProcessTree = z.infer<typeof terminalProcessTreeSchema>
export type TerminalAgentProcessEvidence = {
  proof: TerminalAgentProcessProof | null
  tree: TerminalProcessTree
}

export const ptyAgentProcessEvidenceResponse = ptyAgentProcessEvidenceRequest
  .extend({ proof: terminalAgentProcessProofSchema.nullable(), tree: terminalProcessTreeSchema })
  .nullable()
