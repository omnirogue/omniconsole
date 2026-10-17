import type { ConversationSource } from '../../shared/conversation-source'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import {
  closeWriteFence,
  isWriteFenceOpen,
  openWriteFence,
  registerWriteFenceInvalidator
} from '../runtime/conversation-write-fence'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'

type Runtime = Pick<OrcaRuntimeService, 'sendGuardedSessionKey' | 'readTerminalAgentEvidence'>

/** Even Ctrl+C must reach the proven agent, never a replacement foreground program. */
export async function interruptSessionAgent(
  runtime: Runtime,
  handle: string,
  receiver: TerminalAgentProcessProof,
  source: ConversationSource,
  stillCurrent: () => boolean = () => true
): Promise<void> {
  const token = openWriteFence(source, stillCurrent)
  try {
    const outcome = await runtime.sendGuardedSessionKey(handle, '\x03', receiver, {
      token,
      isRevoked: () => !isWriteFenceOpen(token) || !stillCurrent(),
      onClose: (invalidate) => registerWriteFenceInvalidator(token, invalidate)
    })
    if (outcome === 'unknown') {
      throw new SessionManagePartialError(
        'The interrupt could not be confirmed. Inspect the target before retrying.',
        'an interrupt was dispatched and may have reached the target'
      )
    }
    if (outcome !== 'written') {
      throw new SessionManageRefusal(
        'The target agent changed or its owning writer cannot guard the interrupt. Nothing was interrupted.'
      )
    }
  } finally {
    closeWriteFence(token)
  }
}

/** Missing hooks are not an idle receipt; prove this same agent has returned to a ready screen. */
export async function sessionAgentBackAtPrompt(
  runtime: Runtime,
  handle: string,
  receiver: TerminalAgentProcessProof
): Promise<boolean> {
  try {
    const evidence = await runtime.readTerminalAgentEvidence(handle, receiver.agent)
    const proof = evidence.process
    return Boolean(
      proof &&
      proof.ptyId === receiver.ptyId &&
      proof.pid === receiver.pid &&
      proof.startTimeMs === receiver.startTimeMs &&
      proof.incarnationId === receiver.incarnationId &&
      evidence.screen?.readyPrompt &&
      !evidence.screen.working &&
      !evidence.screen.blocked
    )
  } catch {
    return false
  }
}
