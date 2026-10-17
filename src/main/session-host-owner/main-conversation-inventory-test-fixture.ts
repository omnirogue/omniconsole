/** Persisted workspace sessions and runtime readings for the main-authored ledger's tests. */

import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { providerSessionFolderKey } from '../../shared/session-folder-identity'
import type { SessionInventoryWorkspaceProvenance } from '../../shared/session-inventory-ownership'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { OwnerConversationInventorySource } from './main-conversation-inventory'

export const WORKTREE = 'repo-1::/work/app'
export const LEAF_A = '11111111-1111-4111-8111-111111111111'
export const LEAF_B = '22222222-2222-4222-8222-222222222222'
export const LEAF_C = '33333333-3333-4333-8333-333333333333'

export function terminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE,
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_000,
    launchAgent: 'claude',
    ...overrides
  }
}

export function leafLayout(leafId: string, ptyId?: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {})
  }
}

export function sleepingRecord(
  paneKey: string,
  sessionId: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { key: 'session_id', id: sessionId },
    prompt: 'SENTINEL-PROMPT never published',
    state: 'waiting',
    capturedAt: 2_000,
    updatedAt: 3_000,
    origin: 'quit',
    ...overrides
  }
}

/** The sidebar key the window files a provider conversation of this fixture under. */
export function providerKey(sessionId: string, worktreeId = WORKTREE): string {
  return providerSessionFolderKey({
    hostId: LOCAL_EXECUTION_HOST_ID,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: sessionId }
  })
}

export function workspaceSession(
  parts: Pick<
    WorkspaceSessionState,
    'tabsByWorktree' | 'terminalLayoutsByTabId' | 'sleepingAgentSessionsByPaneKey' | 'unifiedTabs'
  >
): WorkspaceSessionState {
  return { activeRepoId: null, activeWorktreeId: null, activeTabId: null, ...parts }
}

/** A runtime reading whose session and connected PTYs a test changes in place. */
export function inventorySource(
  session: WorkspaceSessionState,
  options: {
    provenance?: (worktreeId: string) => SessionInventoryWorkspaceProvenance
    connectedPtys?: { ptyId: string; paneKey: string | null }[]
  } = {}
): OwnerConversationInventorySource & {
  session: WorkspaceSessionState
  connectedPtys: { ptyId: string; paneKey: string | null }[]
} {
  return {
    session,
    provenance: options.provenance ?? (() => ({ kind: 'owned' })),
    connectedPtys: options.connectedPtys ?? [],
    hookSession: () => null
  }
}
