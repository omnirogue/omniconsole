// The single-entry memo behind selectConversationLedgerEligibility (session parity, step 8). The
// publisher, the group headings, the management rows (built by the done-archive clock, the finish
// tick, the steward and every `omni session` command) and the parity population all read the
// eligibility rule, and each read is a whole second sidebar build; keyed on the identity of what
// that build reads, one sidebar change costs one build however many readers follow it.

import type { AppState } from '@/store/types'
import type { SessionSidebarView } from '@/lib/session-sidebar-view'
import { selectSidebarSessionStatus } from '@/lib/sidebar-session-status-projection'
import type { SessionChain } from '../../../shared/session-chain-types'

/**
 * Every store slice the population reads — the sidebar source, the workspace provenance and the
 * ownership verdicts — by identity. The store replaces a slice whenever it changes.
 */
const ELIGIBILITY_SLICES = [
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'sshConnectionStates',
  'runtimeStatusByEnvironmentId',
  'runtimeEnvironments',
  'removedRuntimeEnvironmentIds',
  'runtimeEnvironmentCatalogHydrated',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'sleepingAgentSessionsByPaneKey',
  'pendingStartupByTabId',
  'automaticAgentResumeClaimsByTabId',
  'localWorkflowStatusByTabId',
  'localWorkflowHydrationByTabId',
  'buildReview',
  'mirroredWorkflowRecordsByOwner'
] as const satisfies readonly (keyof AppState)[]

type Memo<T> = { key: readonly unknown[]; value: T }
let memo: Memo<unknown> | null = null

function eligibilityKey(
  state: AppState,
  view: Pick<SessionSidebarView, 'deleted'>,
  chains: readonly SessionChain[]
): readonly unknown[] {
  return [
    ...ELIGIBILITY_SLICES.map((slice) => state[slice]),
    // Why the projection: a status ping that moves no row keeps its identity (and the memo).
    selectSidebarSessionStatus(state.agentStatusByPaneKey ?? {}),
    view.deleted,
    chains
  ]
}

/** `compute()` once per distinct input identity; the last result otherwise. */
export function memoizedConversationLedgerEligibility<T>(
  state: AppState,
  view: Pick<SessionSidebarView, 'deleted'>,
  chains: readonly SessionChain[],
  compute: () => T
): T {
  const key = eligibilityKey(state, view, chains)
  if (memo && memo.key.length === key.length && memo.key.every((part, i) => part === key[i])) {
    return memo.value as T
  }
  const value = compute()
  memo = { key, value }
  return value
}

export function resetConversationLedgerEligibilityMemoForTests(): void {
  memo = null
}
