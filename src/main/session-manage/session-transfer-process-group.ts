/**
 * Freezing a relocation source: its agent's verified process group is signalled, re-proven first
 * so a reused pid never takes the signal, and the move waits for positive exit evidence. A paired
 * runtime and an SSH relay both freeze this way; each reads its own evidence.
 */

import { PS_LSTART_TOLERANCE_MS, readPosixReceiverRowSync } from '../pty/posix-pty-foreground-group'
import type { RelocationExitEvidence } from './session-transfer-host-action-deps'

const EXIT_WAIT_MS = 15_000
const EXIT_POLL_MS = 250

export type VerifiedAgentProcess = { pid: number; pgid: number; startTimeMs: number }

export function processGroupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Null once the group was signalled; otherwise why it was not. `ending` runs just before. */
export function signalAgentProcessGroup(
  proof: VerifiedAgentProcess,
  ending: (pgid: number) => void
): string | null {
  const receiver = readPosixReceiverRowSync(proof.pid)
  if (
    !receiver?.startTimeMs ||
    Math.abs(receiver.startTimeMs - proof.startTimeMs) > PS_LSTART_TOLERANCE_MS ||
    receiver.pgid !== proof.pgid
  ) {
    return 'its agent process changed before it could be stopped'
  }
  ending(proof.pgid)
  try {
    process.kill(-proof.pgid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return `its agent could not be signalled (${String(error)})`
    }
  }
  return null
}

export async function awaitRelocationExit(
  evidence: () => Promise<RelocationExitEvidence>
): Promise<RelocationExitEvidence> {
  let last: RelocationExitEvidence = { stopped: false, reason: 'it did not exit' }
  for (let waited = 0; waited <= EXIT_WAIT_MS; waited += EXIT_POLL_MS) {
    last = await evidence()
    if (last.stopped) {
      return last
    }
    await new Promise((done) => setTimeout(done, EXIT_POLL_MS))
  }
  return last
}
