import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { collectLeafIds } from '../runtime/workspace-session-layout-membership'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Keeps runtime-authored session state alive across a renderer's full write.
 *
 * A session write replaces the stored object, and the renderer builds its payload from Zustand --
 * which has no idea the runtime authority sharing this profile also persists the client-hosted
 * pages it owns. Without this, every ordinary desktop session write erases them, and the loss only
 * shows up a restart later when there is nothing left to rehydrate.
 *
 * Callers do not opt in: the Store applies this inside setLocalWorkspaceSession and
 * setHostWorkspaceSession, so the before-unload stage path inherits it too. Guarding the individual
 * writers instead is what let the quit write -- the most common one there is -- erase the field.
 *
 * A runtime clearing its own rows writes an empty map, not `undefined`, so this can never pin a
 * stale set: only an author that never mentioned the field inherits the previous one.
 */
export function preserveRuntimeAuthoredWorkspaceSessionFields(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  next = preserveOwnerSleepCheckpoints(next, prior)
  if (
    next.clientHostedBrowserPagesByWorktree !== undefined ||
    prior?.clientHostedBrowserPagesByWorktree === undefined
  ) {
    return next
  }
  return {
    ...next,
    clientHostedBrowserPagesByWorktree: prior.clientHostedBrowserPagesByWorktree
  }
}

function preserveOwnerSleepCheckpoints(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  let records = next.sleepingAgentSessionsByPaneKey
  for (const [paneKey, record] of Object.entries(prior?.sleepingAgentSessionsByPaneKey ?? {})) {
    const incarnation = record.ownerSleepPtyIncarnationId
    if (!incarnation || (records?.[paneKey]?.capturedAt ?? 0) > record.capturedAt) {
      continue
    }
    const replacement = next.terminalPtyIncarnationsByPaneKey?.[paneKey]
    const closed = record.tabId && next.closedTerminalTabTombstonesByTabId?.[record.tabId]
    if (closed || (replacement && replacement !== incarnation) || surfaceWasRemoved(next, record)) {
      if (records?.[paneKey]) {
        records = { ...records }
        delete records[paneKey]
      }
      continue
    }
    if (
      records?.[paneKey]?.ownerSleepPtyIncarnationId === incarnation &&
      records[paneKey].capturedAt === record.capturedAt
    ) {
      continue
    }
    // An old window has not seen the checkpoint; its full save cannot erase the only resume key.
    records = { ...records, [paneKey]: record }
  }
  return records === next.sleepingAgentSessionsByPaneKey
    ? next
    : { ...next, sleepingAgentSessionsByPaneKey: records }
}

/** Callers first apply the host topology fence; omitted topology alone is not a close. */
function surfaceWasRemoved(
  next: WorkspaceSessionState,
  record: SleepingAgentSessionRecord
): boolean {
  const pane = parsePaneKey(record.paneKey)
  if (!pane || !record.tabId || !Object.hasOwn(next.tabsByWorktree, record.worktreeId)) {
    return false
  }
  if (!next.tabsByWorktree[record.worktreeId].some((tab) => tab.id === record.tabId)) {
    return true
  }
  const layout = next.terminalLayoutsByTabId[record.tabId]
  if (!layout?.root) {
    return false
  }
  const leaves = new Set<string>()
  collectLeafIds(layout.root, leaves)
  return !leaves.has(pane.leafId)
}
