import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  isWebTerminalSurfaceTabId,
  parseWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import {
  getCatalogRuntimeOwnerEnvironmentId,
  getSessionInventoryWorkspaceProvenance
} from './session-inventory-workspace-provenance'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

export type MirrorRecordRelaunchState = WorktreeRuntimeOwnerState & {
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[] | undefined>>
  terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
}

function layoutHasLeaf(node: TerminalPaneLayoutNode | null | undefined, leafId: string): boolean {
  return Boolean(
    node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : layoutHasLeaf(node.first, leafId) || layoutHasLeaf(node.second, leafId))
  )
}

/**
 * Whether a `web-terminal-*` pane names another computer as its owner: an owner-qualified id, a
 * workspace the saved catalog credits to a paired computer, or a remote PTY id on the row or its
 * surviving layout husk. Without any of them the pane is this computer's own (a legacy
 * web-prefixed tab bound to a local PTY) or simply unattributed, and is never refused here.
 */
function paneHasAnotherOwner(
  record: SleepingAgentSessionRecord,
  tabId: string,
  tab: TerminalTab | undefined,
  layout: TerminalLayoutSnapshot | undefined,
  state: MirrorRecordRelaunchState
): boolean {
  if (parseWebTerminalSurfaceTabId(tabId)?.environmentId) {
    return true
  }
  if (getCatalogRuntimeOwnerEnvironmentId(state, record.worktreeId) !== null) {
    return true
  }
  return [tab?.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].some(
    (ptyId) => typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
  )
}

/**
 * Whether relaunching `record` in a new tab could resume a conversation another computer closed
 * (session-count fix, A4 / C3). A record of a pane another computer owns names that owner's
 * conversation, and only the owner decides whether it still runs: relaunching one whose pane the
 * owner no longer lists started, on the owner, the conversation it had closed. So such a record
 * relaunches only while this computer's mirror lists that exact pane from the owner's accepted
 * frames (and does not hold it as "can't verify"). The owner omitted the pane, or the tab is gone
 * after a restart: not relaunched; the record is kept for the owner's next complete membership to
 * retire. Only a pane whose id, catalog or PTY evidence names another owner is held to this;
 * this computer's own records (a legacy web-prefixed pane with a local PTY in a workspace no
 * paired computer owns, its tab closed or slept) resume as before.
 */
export function isMirrorRecordRelaunchRefused(
  record: SleepingAgentSessionRecord,
  state: MirrorRecordRelaunchState
): boolean {
  const pane = parsePaneKey(record.paneKey)
  const tabId = record.tabId ?? pane?.tabId ?? null
  if (!tabId || !isWebTerminalSurfaceTabId(tabId) || record.connectionId) {
    return false
  }
  const tab = state.tabsByWorktree[record.worktreeId]?.find((row) => row.id === tabId)
  const layout = state.terminalLayoutsByTabId[tabId]
  if (!paneHasAnotherOwner(record, tabId, tab, layout, state)) {
    return false
  }
  if (!tab || tab.mirrorAbsenceUnverified) {
    return true
  }
  const leafId = pane?.leafId
  return Boolean(
    leafId && !layoutHasLeaf(layout?.root, leafId) && !(leafId in (layout?.ptyIdsByLeafId ?? {}))
  )
}

/**
 * Whether `record` is held under a workspace this computer does not own (session parity, step 7):
 * one the saved catalog credits to a paired computer, or one it cannot settle. Whatever its pane
 * id — a mirror pane, or a plain UUID the activation sweep re-keyed it onto (C4) — launching it
 * here starts that computer's conversation again there; the owner resumes its own.
 */
export function isNonOwnedWorkspaceRecordLaunchRefused(
  record: Pick<SleepingAgentSessionRecord, 'worktreeId'>,
  state: WorktreeRuntimeOwnerState
): boolean {
  return getSessionInventoryWorkspaceProvenance(state, record.worktreeId).kind !== 'owned'
}

/** Why a refused relaunch is refused, for the person who asked for it. */
export function mirrorRecordRelaunchRefusalReason(
  record: SleepingAgentSessionRecord,
  state: MirrorRecordRelaunchState
): 'unverified' | 'not-listed' {
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
  const tab = state.tabsByWorktree[record.worktreeId]?.find((row) => row.id === tabId)
  return tab?.mirrorAbsenceUnverified ? 'unverified' : 'not-listed'
}
