import { setAutomaticArchiveChecks } from './session-automatic-archive-guard'
import { sessionCompletionIdentity } from '../../../shared/session-archive-proof'
import { findShownSessionChainForRow } from './session-chain-registry'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useWaitLater } from '@/store/wait-later-store'
import { selectAgentPaneSnapshotInputs } from '@/components/attention/use-agent-pane-snapshot'
import {
  DONE_ARCHIVE_DEFAULT_MINUTES,
  DONE_ARCHIVE_IDLE_REASON,
  doneArchiveDue,
  doneArchiveEvidence
} from '../../../shared/session-done-archive'
import type { OrganizationChange } from '../../../shared/session-organization-change'
import {
  emptySessionEvidence,
  isStewardEmptySessionArchive
} from '../../../shared/session-steward-empty-session'
import { isStewardUnreachableBlankArchive } from '../../../shared/session-steward-unreachable-blank'
import { unreachableBlankRefusal } from './session-unreachable-blank'
import type { SessionSidebarView } from './session-sidebar-view'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'

/** Persist transitions only; the existing finish tick owns scheduling. */
export function updateDoneArchiveClocks(now = Date.now()): void {
  const store = useSessionSidebarView.getState()
  if (!store.loaded || !store.archiveStorageReady || !useSessionFolders.getState().loaded) {
    return
  }
  const previous = store.view.doneArchiveClocks ?? {}
  const next: NonNullable<SessionSidebarView['doneArchiveClocks']> = {}
  let count = 0
  if ((store.view.doneArchiveMinutes ?? DONE_ARCHIVE_DEFAULT_MINUTES) > 0) {
    for (const row of buildSessionManageSidebarRows(useAppStore.getState(), now)) {
      const revision = row.doneArchiveRevision
      if (!revision || row.pinned || row.folded || count >= 1000) {
        continue
      }
      count += 1
      const clock = previous[row.viewKey]
      next[row.viewKey] =
        clock?.revision === revision && clock.since <= now ? clock : { revision, since: now }
    }
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    store.setDoneArchiveClocks(next)
  }
}

/** Observe attention/activity immediately, including a bell raised and read between ticks. */
export function watchDoneArchiveClocks(): () => void {
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (scheduled !== null) {
      return
    }
    scheduled = setTimeout(() => {
      scheduled = null
      updateDoneArchiveClocks()
    }, 250)
  }
  const removeChecks = setAutomaticArchiveChecks({
    refusal: automaticArchiveRefusal,
    receipt: automaticArchiveReceipt
  })
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    const a = Object.values(selectAgentPaneSnapshotInputs(next))
    const b = Object.values(selectAgentPaneSnapshotInputs(previous))
    if (
      next.workspaceSessionReady !== previous.workspaceSessionReady ||
      next.acknowledgedAgentsByPaneKey !== previous.acknowledgedAgentsByPaneKey ||
      next.unreadAgentCompletionPanes !== previous.unreadAgentCompletionPanes
    ) {
      updateDoneArchiveClocks()
    } else if (a.some((value, i) => value !== b[i])) {
      schedule()
    }
  })
  const folders = useSessionFolders.subscribe(() => updateDoneArchiveClocks())
  const waits = useWaitLater.subscribe(() => updateDoneArchiveClocks())
  const sidebar = useSessionSidebarView.subscribe((next, previous) => {
    if (
      next.loaded !== previous.loaded ||
      next.archiveStorageReady !== previous.archiveStorageReady ||
      next.archived !== previous.archived ||
      next.view.autoArchiveKeep !== previous.view.autoArchiveKeep ||
      next.view.doneArchiveMinutes !== previous.view.doneArchiveMinutes ||
      next.view.deleted !== previous.view.deleted
    ) {
      updateDoneArchiveClocks()
    }
  })
  return () => {
    if (scheduled !== null) {
      clearTimeout(scheduled)
    }
    removeChecks()
    unsubscribe()
    folders()
    waits()
    sidebar()
  }
}

const ARCHIVE_CHANGED =
  'The Done clock, attention or completion evidence changed; the session stays visible.'

/** Last synchronous check, after the audit prepare await and immediately before filing. */
export function automaticArchiveRefusal(change: OrganizationChange): string | null {
  if (
    change.kind !== 'archive' ||
    change.executor.kind !== 'app' ||
    !['auto-archive', 'steward'].includes(change.executor.feature)
  ) {
    return null
  }
  const store = useSessionSidebarView.getState()
  if (!store.loaded || !store.archiveStorageReady) {
    return 'Archive settings could not be read.'
  }
  const rows = buildSessionManageSidebarRows(useAppStore.getState())
  // Why: an empty session (nobody prompted it) has no completed turn, so it can never carry a
  // Done clock. Its own rule decided on the owning host; this check confirms the row is still
  // the idle, unprompted one it judged, by the revision main wrote into the evidence.
  const empty = isStewardEmptySessionArchive(change)
  const unreachable = isStewardUnreachableBlankArchive(change)
  for (const target of change.targets) {
    const row = rows.find((candidate) =>
      target.sessionKey
        ? candidate.viewKey === target.sessionKey
        : candidate.paneKey === target.paneKey &&
          (!target.tabId || candidate.tabId === target.tabId)
    )
    if (!row || row.pinned || row.folded) {
      return ARCHIVE_CHANGED
    }
    // Why its own branch: the third rule's row is on an unreachable host, with no Done clock.
    if (unreachable) {
      const refusal = unreachableBlankRefusal(row, change.evidence)
      if (refusal) {
        return refusal
      }
      continue
    }
    if (empty) {
      // Why not the Done revision: a SessionStart alone lands a "done" status, so an empty pane
      // does carry one; emptiness is main's transcript reading, revalidated by this revision.
      const revision = row.emptyArchiveRevision
      if (!revision || !change.evidence?.includes(emptySessionEvidence(row.viewKey, revision))) {
        return 'The session is no longer empty and idle, or is held; it stays visible.'
      }
      continue
    }
    const policy = row.doneArchivePolicy
    if (
      !policy ||
      !doneArchiveDue(policy, Date.now()) ||
      !change.evidence?.includes(doneArchiveEvidence(row.viewKey, policy))
    ) {
      return ARCHIVE_CHANGED
    }
    // Why: the idle rule is for conversations with no plan on this computer; a plan that
    // appeared since the judgment needs its own proof.
    if (
      change.reason === DONE_ARCHIVE_IDLE_REASON &&
      ((row.hostId ?? 'local') !== 'local' || findShownSessionChainForRow(row.rowKey))
    ) {
      return 'The session now has a plan or runs elsewhere; it stays visible.'
    }
  }
  return null
}

export function automaticArchiveReceipt(key: string): string {
  const row = buildSessionManageSidebarRows(useAppStore.getState()).find(
    (row) => row.viewKey === key
  )
  const chain = row ? findShownSessionChainForRow(row.rowKey) : null
  return (
    (chain && sessionCompletionIdentity(chain)) ??
    `advisory:${row?.doneArchiveRevision ?? 'unknown'}`
  )
}
