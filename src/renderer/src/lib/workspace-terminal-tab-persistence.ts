import type { TerminalTab } from '../../../shared/terminal-tab-types'

/** Receiver evidence and launch-in-progress flags must be re-established after restart. The
 *  paired owner's session names are kept: until its next frame lands, a restored mirror otherwise
 *  showed this computer's stale names for the owner's sessions. */
export function persistedTerminalTab(tab: TerminalTab) {
  const {
    pendingActivationSpawn,
    conversationLaunchPending,
    mirrorAbsenceUnverified,
    runtimeOwnerTabId,
    runtimeOwnerArchiveByLeafId,
    ...rest
  } = tab
  void pendingActivationSpawn
  void conversationLaunchPending
  void mirrorAbsenceUnverified
  void runtimeOwnerTabId
  void runtimeOwnerArchiveByLeafId
  return rest
}
