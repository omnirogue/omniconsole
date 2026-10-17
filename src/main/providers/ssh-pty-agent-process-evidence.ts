import {
  PTY_AGENT_PROCESS_EVIDENCE_METHOD,
  ptyAgentProcessEvidenceResponse,
  type TerminalAgentProcessEvidence
} from '../../shared/pty-agent-process-evidence'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'

export function createSshPtyAgentEvidenceReader(args: {
  mux: SshChannelMultiplexer
  toRelayPtyId: (id: string) => string
  hasPty: (id: string) => boolean
  getIncarnation: (relayPtyId: string) => string | undefined
}): (id: string, incarnationId: string) => Promise<TerminalAgentProcessEvidence | null> {
  let unsupported = false
  const isCurrent = (id: string, incarnationId: string) =>
    !args.mux.isDisposed() &&
    args.hasPty(id) &&
    args.getIncarnation(args.toRelayPtyId(id)) === incarnationId
  return async (id, incarnationId) => {
    if (unsupported || !isCurrent(id, incarnationId)) {
      return null
    }
    const relayId = args.toRelayPtyId(id)
    try {
      const parsed = ptyAgentProcessEvidenceResponse.safeParse(
        await args.mux.request(
          PTY_AGENT_PROCESS_EVIDENCE_METHOD,
          { id: relayId, incarnationId },
          { timeoutMs: 5_000 }
        )
      )
      const evidence = parsed.success ? parsed.data : null
      if (
        !evidence ||
        !isCurrent(id, incarnationId) ||
        evidence.id !== relayId ||
        evidence.incarnationId !== incarnationId ||
        (evidence.proof &&
          (evidence.proof.ptyId !== relayId || evidence.proof.incarnationId !== incarnationId))
      ) {
        return null
      }
      return {
        proof: evidence.proof ? { ...evidence.proof, ptyId: id } : null,
        tree: evidence.tree
      }
    } catch (error) {
      unsupported = isJsonRpcMethodNotFoundError(error)
      return null
    }
  }
}
