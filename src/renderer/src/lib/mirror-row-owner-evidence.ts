import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isStablePaneId, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  isWebOnlyMirroredTerminalTab,
  isWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { hasHostSessionMirrorHydrated } from '@/runtime/host-session-mirror-hydration'
import { resolveMirroredTerminalRowOwner } from '@/runtime/web-session-mirror-owner'
import { getCatalogRuntimeOwnerEnvironmentId } from './session-inventory-workspace-provenance'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'

/**
 * Which mirror rows the owner itself vouches for as conversations (session-count fix, A4).
 *
 * A paired owner's frame carries a pane's conversation only as its live agent status or the tab's
 * launch agent. A mirror row whose conversation comes solely from this computer — its own
 * hibernation record, or the AI vault title it stamped on the tab — may be a conversation the
 * owner ended long ago (live on 6 Oct: 7 MacBook shells the Studio still listed), or one the owner
 * still shows from a record that never crosses the wire. Neither can be told apart here, so such a
 * row is kept and labelled "can't verify" rather than counted as a plain conversation.
 */

export type MirrorRowEvidenceState = WorktreeRuntimeOwnerState & {
  agentStatusByPaneKey?: Readonly<Record<string, AgentStatusEntry | undefined>>
  terminalLayoutsByTabId?: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
  ptyIdsByTabId?: Readonly<Record<string, readonly string[] | undefined>>
  unifiedTabsByWorktree?: Readonly<Record<string, readonly Tab[] | undefined>>
}

/**
 * A row built from this computer's record of another computer's pane, with no tab of it here. A
 * row an owner's ledger vouches for is that owner's conversation, never such a record (step 6).
 */
export function isRecordOnlyMirrorRow(session: {
  kind: string
  tabId: string | null
  paneKey?: string | null
  hostId?: string | null
  mirroredConversation?: MirroredSidebarConversation
}): boolean {
  const tabId = session.paneKey ? parsePaneKey(session.paneKey)?.tabId : undefined
  if (
    session.kind !== 'terminal' ||
    session.tabId !== null ||
    tabId === undefined ||
    session.mirroredConversation
  ) {
    return false
  }
  const host = parseExecutionHostId(session.hostId)
  // Why (C4): under a paired runtime a record is that computer's pane whatever its id form — the
  // MacBook re-keyed Studio records onto plain-UUID tabs — while a local or SSH record is this
  // computer's own. A record no host claims is a mirror only by its web-terminal id.
  return host?.kind === 'runtime'
    ? isWebTerminalSurfaceTabId(tabId) || isStablePaneId(tabId)
    : host === null && isWebTerminalSurfaceTabId(tabId)
}

/**
 * A record-only mirror row no computer can speak for (live 6 Oct: six MacBook worktrees deleted
 * there, shown under "unknown" on the Studio): no host this computer can name, and no tab of its
 * workspace here from any computer. Only the person can let it go (tidy/delete `--unverified`).
 */
export function isStrandedMirrorRecordRow(
  state: { tabsByWorktree?: Readonly<Record<string, readonly TerminalTab[] | undefined>> } & {
    unifiedTabsByWorktree?: Readonly<Record<string, readonly Tab[] | undefined>>
  },
  session: {
    kind: string
    tabId: string | null
    paneKey?: string | null
    hostId: string | null
    worktreeId: string
    mirroredConversation?: MirroredSidebarConversation
  }
): boolean {
  return (
    isRecordOnlyMirrorRow(session) &&
    session.hostId === null &&
    (state.tabsByWorktree?.[session.worktreeId]?.length ?? 0) === 0 &&
    (state.unifiedTabsByWorktree?.[session.worktreeId]?.length ?? 0) === 0
  )
}

/** The session-management flags of a record-only mirror row (see SessionManageSidebarRow). */
export function recordOnlyMirrorRowFlags(
  state: Parameters<typeof isStrandedMirrorRecordRow>[0],
  session: Parameters<typeof isStrandedMirrorRecordRow>[1]
): { recordOnlyMirror?: true; strandedMirrorRecord?: true } {
  if (!isRecordOnlyMirrorRow(session)) {
    return {}
  }
  return isStrandedMirrorRecordRow(state, session)
    ? { recordOnlyMirror: true, strandedMirrorRecord: true }
    : { recordOnlyMirror: true }
}

function mirrorRowOwnerEnvironmentId(
  state: MirrorRowEvidenceState,
  worktreeId: string,
  tab: TerminalTab
): string | null {
  const unifiedTab = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (row) => row.contentType === 'terminal' && row.entityId === tab.id
  )
  const owner = resolveMirroredTerminalRowOwner(tab, {
    layout: state.terminalLayoutsByTabId?.[tab.id],
    ptyIds: state.ptyIdsByTabId?.[tab.id],
    unifiedTab
  })
  if (owner.kind === 'owned') {
    return owner.environmentId
  }
  return owner.kind === 'unknown' ? getCatalogRuntimeOwnerEnvironmentId(state, worktreeId) : null
}

/**
 * True for a mirror row of a pane the owner has answered for (its mirror settled for the
 * workspace) without vouching for a conversation on it. Before the owner answers, a restored row
 * is simply waiting and is not labelled.
 */
export function mirrorRowLacksOwnerConversationEvidence(
  state: MirrorRowEvidenceState,
  session: { worktreeId: string; paneKey?: string | null },
  tab: TerminalTab
): boolean {
  if (
    !session.paneKey ||
    tab.launchAgent ||
    !isWebOnlyMirroredTerminalTab(tab, state.terminalLayoutsByTabId?.[tab.id]) ||
    state.agentStatusByPaneKey?.[session.paneKey]
  ) {
    return false
  }
  const environmentId = mirrorRowOwnerEnvironmentId(state, session.worktreeId, tab)
  return environmentId !== null && hasHostSessionMirrorHydrated(environmentId, session.worktreeId)
}
