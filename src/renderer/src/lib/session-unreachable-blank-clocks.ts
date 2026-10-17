import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import type { UnreachableBlankClock } from '../../../shared/session-steward-unreachable-blank'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'

/**
 * Keeps one clock per blank row on an unreachable SSH host, persisted with the sidebar view so a
 * restart does not start the day over. A row whose host is still being decided keeps its clock
 * untouched and never starts one; anything else drops it.
 */
export function updateUnreachableBlankClocks(
  rows: readonly Pick<SessionManageSidebarRow, 'viewKey' | 'unreachableBlankRevision'>[],
  now = Date.now()
): void {
  const store = useSessionSidebarView.getState()
  if (!store.loaded || !store.archiveStorageReady || !useSessionFolders.getState().loaded) {
    return
  }
  const previous = store.view.unreachableBlankClocks ?? {}
  const next: Record<string, UnreachableBlankClock> = {}
  for (const row of rows) {
    const clock = previous[row.viewKey]
    const revision = row.unreachableBlankRevision
    if (revision === undefined && clock) {
      next[row.viewKey] = clock
    } else if (revision) {
      next[row.viewKey] =
        clock?.revision === revision && clock.since <= now ? clock : { revision, since: now }
    }
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    store.setUnreachableBlankClocks(next)
  }
}

/** The finish tick's call: skipped while every SSH host answers and no clock runs. */
export function updateUnreachableBlankClocksNow(): void {
  const state = useAppStore.getState()
  const clocks = useSessionSidebarView.getState().view.unreachableBlankClocks ?? {}
  const unreached = [...(state.sshConnectionStates?.values() ?? [])].some(
    (connection) => connection.status !== 'connected'
  )
  if (unreached || Object.keys(clocks).length > 0) {
    updateUnreachableBlankClocks(buildSessionManageSidebarRows(state))
  }
}
