import type {
  GuardedWriteOutcome,
  GuardedWriteReceiver,
  WriteFence
} from '../../../pty/guarded-pty-write'
import { agentSessionPtyWriteGate } from '../../../runtime/agent-session-pty-write-gate'
import { reportAgentSessionWriteRefusal } from '../agent-session-write-refusal-report'
import { getProviderForPty } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'

/** A write the owning provider performs only while `receiver` holds the tty. */
export async function guardedWritePtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  data: string,
  receiver: GuardedWriteReceiver,
  fence?: WriteFence
): Promise<GuardedWriteOutcome> {
  const admission = agentSessionPtyWriteGate.admit(ptyId)
  if (!admission.admitted) {
    reportAgentSessionWriteRefusal(deps.mainWindow, ptyId, admission.refusal)
    return 'refused'
  }
  try {
    const provider = getProviderForPty(ptyId)
    return provider.guardedWrite
      ? await provider.guardedWrite(ptyId, data, receiver, fence)
      : 'unsupported'
  } catch {
    return 'unknown'
  }
}

/** A fence revocation for a PTY whose writer is another process; main's own check needs none. */
export function revokeWriteFenceFromRuntimeController(ptyId: string, token: string): void {
  try {
    getProviderForPty(ptyId).revokeWriteFence?.(ptyId, token)
  } catch {
    // Its next fenced write is refused at main or at the daemon; nothing here can do more.
  }
}
