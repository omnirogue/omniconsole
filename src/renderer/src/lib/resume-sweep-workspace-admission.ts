import { getSessionInventoryWorkspaceProvenance } from './session-inventory-workspace-provenance'
import {
  resolveWorkspaceTerminalHostAuthority,
  type WorkspaceTerminalHostAuthorityState
} from './workspace-terminal-host-authority'

/**
 * Whether a resume sweep may act on a workspace's sleeping records at all. Not while its terminal
 * host has not answered (`unverifiable`, STA-3500), and never in a workspace the saved catalog
 * credits to a paired computer or cannot settle (peer or unresolved provenance, session parity
 * step 7): every record there is a capture of a conversation that computer runs, and launching it
 * started that conversation again there (C4). The owner resumes its own; the records stay for its
 * conversation ledger to vouch for or retire.
 */
export function resumeSweepMayActOnWorkspace(
  state: WorkspaceTerminalHostAuthorityState,
  worktreeId: string
): boolean {
  return (
    resolveWorkspaceTerminalHostAuthority(state, worktreeId) !== 'unverifiable' &&
    getSessionInventoryWorkspaceProvenance(state, worktreeId).kind === 'owned'
  )
}
