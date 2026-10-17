import { sessionLedgerService } from '../../../session-ledger/ledger-service'
import type { LedgerResumeSpawn } from '../../../session-ledger/ledger-resume-links'

/** Called only after the owning provider acknowledges the requested fresh spawn. */
export async function carryResumedTaskForSpawn(
  spawn: Partial<LedgerResumeSpawn>,
  isReattach?: boolean
): Promise<void> {
  if (
    isReattach ||
    !spawn.providerSession ||
    !spawn.paneKey ||
    !spawn.ptyId ||
    !spawn.worktreeId ||
    !spawn.agent
  ) {
    return
  }
  try {
    await sessionLedgerService.resumeLinks.carry({
      ...spawn,
      paneKey: spawn.paneKey,
      ptyId: spawn.ptyId,
      worktreeId: spawn.worktreeId,
      agent: spawn.agent,
      connectionId: spawn.connectionId ?? null,
      providerSession: spawn.providerSession
    })
  } catch (error) {
    console.warn('[session-ledger] resumed task link unavailable', error)
  }
}
