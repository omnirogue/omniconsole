import { manualArchiveView, verifiedArchiveView } from '@/lib/session-sidebar-archive-state'
import { toast } from 'sonner'
import { sessionSidebarStartupView, withSessionHostFilter } from '@/lib/session-host-scope'
import { create } from 'zustand'
import {
  persistTransferArchive,
  readTransferArchiveReceipt,
  recoverTransferArchiveProjections
} from '@/lib/session-transfer-archive-storage'
import {
  emptySessionSidebarView,
  moveSessionGroup,
  setSessionGroupHidden,
  setSessionGroupsCollapsed,
  setSessionRowExpanded,
  setWorkHeaderCollapsed as setWorkHeaderCollapsedInView,
  toggleSessionGroupCollapsed,
  withSavedShowAll,
  withSessionSidebarGroupBy,
  type SessionSidebarView
} from '@/lib/session-sidebar-view'
import { withSessionSidebarViewChoice } from '@/lib/session-sidebar-view-choice'
import {
  createLocalSessionSidebarViewStorage,
  type SessionSidebarViewStorage
} from '@/lib/session-sidebar-view-storage'
import {
  createLocalSessionArchivedStorage,
  type SessionArchivedStorage
} from '@/lib/session-sidebar-archive-storage'
export {
  createLocalSessionArchivedStorage,
  SESSION_ARCHIVED_STORAGE_KEY,
  type SessionArchivedStorage
} from '@/lib/session-sidebar-archive-storage'
import type { SessionSidebarViewState } from './session-sidebar-view-state'
import { noteSessionsArchived } from '@/lib/account-sync/session-organization-intent'
import { emitConversationArchiveChange } from '@/lib/session-archive-events'
import { announceArchiveChanges } from './session-sidebar-view-archive-notices'

export function createSessionSidebarViewStore(
  storage: SessionSidebarViewStorage,
  archivedStorage: SessionArchivedStorage = createLocalSessionArchivedStorage()
) {
  return create<SessionSidebarViewState>((set, get) => {
    let unreadable = false
    const save = (view: SessionSidebarView): boolean => {
      // Why: a storage failure must not undo the on-screen change; the view is a convenience, not data.
      if (unreadable) {
        set({ view, archived: view.archived ?? [], archiveStorageReady: false })
        return false
      }
      try {
        storage.save(view)
      } catch {
        set({ view, archived: view.archived ?? [], archiveStorageReady: false })
        return false
      }
      set({ view, archived: view.archived ?? [] })
      return true
    }
    const saveArchived = (
      archived: readonly string[],
      view: SessionSidebarView = get().view
    ): boolean => {
      if (unreadable) {
        return save({ ...view, archived: [...archived] })
      }
      try {
        archivedStorage.save(archived)
      } catch {
        // ignore
      }
      return save({ ...view, archived: [...archived] })
    }
    return {
      view: emptySessionSidebarView(),
      archived: [],
      loaded: false,
      archiveStorageReady: false,
      showHidden: false,
      load: () => {
        let view: SessionSidebarView
        let archiveStorageReady = true
        try {
          view = storage.load()
        } catch {
          view = emptySessionSidebarView()
          archiveStorageReady = false
        }
        let archived: readonly string[] = []
        try {
          archived = archivedStorage.load()
        } catch {
          archiveStorageReady = false
        }
        archived = view.archived ?? archived
        view = { ...view, archived: [...archived] }
        view = sessionSidebarStartupView(view, get().loaded)
        try {
          view = recoverTransferArchiveProjections(storage, view)
        } catch {
          /* Durable main decisions remain pending for the next load. */
        }
        unreadable = !archiveStorageReady
        set({ view, archived: view.archived ?? archived, loaded: true, archiveStorageReady })
      },
      setShowHidden: (showHidden) => set({ showHidden }),
      toggleCollapsed: (key) => save(toggleSessionGroupCollapsed(get().view, key)),
      setCollapsed: (keys, collapsed) =>
        save(setSessionGroupsCollapsed(get().view, keys, collapsed)),
      setHidden: (key, hidden) => save(setSessionGroupHidden(get().view, key, hidden)),
      setRowExpanded: (key, expanded) => save(setSessionRowExpanded(get().view, key, expanded)),
      setHiddenMany: (keys, hidden) => {
        if (keys.length > 0) {
          save(keys.reduce((next, key) => setSessionGroupHidden(next, key, hidden), get().view))
        }
      },
      setArchived: (keys, archived, origin) => {
        if (keys.length === 0) {
          return
        }
        const next = manualArchiveView(get().view, keys, archived, origin, Date.now())
        const saved = saveArchived(next.archived ?? [], next)
        if (!saved && !archived) {
          toast.error(
            'Session restored, but the keep-visible choice could not be saved. Automatic archiving is paused on this device.',
            { id: 'session-archive-storage' }
          )
        }
        if (origin !== 'account-sync') {
          noteSessionsArchived(keys)
        }
      },
      archiveTransfer: (keys, operationId, commit) => {
        const view = persistTransferArchive(storage, get().view, keys, operationId, commit)
        set({ view, archived: view.archived ?? [] })
        noteSessionsArchived(keys)
      },
      readTransferArchiveReceipt: (operationId) => readTransferArchiveReceipt(storage, operationId),
      archiveVerified: (key, proof) => {
        const { view, loaded, archived, archiveStorageReady } = get()
        if (
          !loaded ||
          !archiveStorageReady ||
          archived.includes(key) ||
          view.autoArchiveKeep?.includes(key)
        ) {
          return false
        }
        // Preserve every audit receipt; stop filing rather than filling the device store or pruning history.
        if (
          (view.autoArchiveLog?.length ?? 0) >= 1000 ||
          JSON.stringify(view.autoArchiveLog ?? []).length + proof.length > 500_000
        ) {
          return false
        }
        const next = verifiedArchiveView(view, key, proof, Date.now())
        // Automatic filing requires a durable receipt. A failed write leaves the row visible.
        try {
          storage.save(next)
        } catch {
          return false
        }
        set({ view: next, archived: next.archived ?? [] })
        noteSessionsArchived([key])
        return true
      },
      setDeleted: (keys, deleted) => {
        if (keys.length === 0) {
          return
        }
        const next = new Set(get().view.deleted ?? [])
        for (const key of keys) {
          if (deleted) {
            next.add(key)
          } else {
            next.delete(key)
          }
        }
        save({ ...get().view, deleted: [...next] })
      },
      setGroupColor: (key, color) => {
        const colors = { ...get().view.colors }
        if (color === null) {
          delete colors[key]
        } else {
          colors[key] = color
        }
        save({ ...get().view, colors })
      },
      snooze: (keys, until) => {
        const view = get().view
        const snoozedUntil = { ...view.snoozedUntil }
        for (const key of keys) {
          if (until === null) {
            delete snoozedUntil[key]
          } else {
            snoozedUntil[key] = until
          }
        }
        save({ ...view, snoozedUntil })
      },
      setCompanyVisible: (key, visible) =>
        save({
          ...get().view,
          companyVisibility: { ...get().view.companyVisibility, [key]: visible }
        }),
      setGroupBy: (groupBy) => save(withSessionSidebarGroupBy(get().view, groupBy)),
      setHostFilter: (filter, hostScope) =>
        save(withSessionHostFilter(get().view, filter, hostScope)),
      setDensity: (density) => save({ ...get().view, density }),
      setLayout: (layout) => save({ ...get().view, layout, flat: false }),
      setViewChoice: (choice) => save(withSessionSidebarViewChoice(get().view, choice)),
      setSort: (sort) => save({ ...get().view, sort }),
      setSavedShowAll: (on, savedKeys) => save(withSavedShowAll(get().view, on, savedKeys)),
      setDoneArchiveMinutes: (minutes) => {
        if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 43200) {
          save({ ...get().view, doneArchiveMinutes: minutes, doneArchiveClocks: {} })
        }
      },
      setDoneArchiveClocks: (doneArchiveClocks) => save({ ...get().view, doneArchiveClocks }),
      setUnreachableBlankClocks: (unreachableBlankClocks) =>
        save({ ...get().view, unreachableBlankClocks }),
      setAutoCollapseSeconds: (seconds) =>
        save({ ...get().view, autoCollapseSeconds: Math.max(0, Math.round(seconds)) }),
      moveRow: (key, target, keys) => {
        const view = get().view
        const moved = moveSessionGroup(
          { ...view, order: view.rowOrder ?? [] },
          { key, target, position: 'before', visibleKeys: keys }
        )
        // Why Manual: a dragged order only shows under it, so dragging a row chooses it.
        save({ ...view, rowOrder: moved.order, sort: 'manual' })
      },
      migrateSessionKey: (from, to) => {
        const { view, archived } = get()
        const replace = (key: string): string => (key === from ? to : key)
        if (archived.includes(from)) {
          saveArchived([...new Set(archived.map(replace))], {
            ...view,
            archivedAt: Object.fromEntries(
              Object.entries(view.archivedAt ?? {}).map(([key, value]) => [replace(key), value])
            )
          })
        }
        if (
          !view.hidden.some((key) => key.endsWith(`:${from}`)) &&
          !view.rowOrder?.includes(from) &&
          !view.archived?.includes(from) &&
          !view.expandedRows?.includes(from) &&
          !view.autoArchiveKeep?.includes(from) &&
          !view.autoArchiveLog?.some((entry) => entry.key === from) &&
          view.snoozedUntil?.[from] === undefined &&
          view.workHeaderCollapsed?.[from] === undefined
        ) {
          return
        }
        save({
          ...view,
          hidden: view.hidden.map((key) =>
            key === `conversation:${from}`
              ? `conversation:${to}`
              : key === `session:${from}`
                ? `session:${to}`
                : key
          ),
          rowOrder: view.rowOrder?.map(replace),
          archived: view.archived?.map(replace),
          ...(view.archivedAt
            ? {
                archivedAt: Object.fromEntries(
                  Object.entries(view.archivedAt).map(([key, value]) => [replace(key), value])
                )
              }
            : {}),
          expandedRows: view.expandedRows?.map(replace),
          autoArchiveKeep: view.autoArchiveKeep?.map(replace),
          autoArchiveLog: view.autoArchiveLog?.map((entry) => ({
            ...entry,
            key: replace(entry.key)
          })),
          snoozedUntil: Object.fromEntries(
            Object.entries(view.snoozedUntil ?? {}).map(([key, value]) => [replace(key), value])
          ),
          ...(view.workHeaderCollapsed
            ? {
                workHeaderCollapsed: Object.fromEntries(
                  Object.entries(view.workHeaderCollapsed).map(([key, value]) => [
                    replace(key),
                    value
                  ])
                )
              }
            : {})
        })
      },
      moveGroup: (args) => save(moveSessionGroup(get().view, args)),
      setWorkHeaderCollapsed: (key, collapsed) =>
        save(setWorkHeaderCollapsedInView(get().view, key, collapsed))
    }
  })
}

export const useSessionSidebarView = createSessionSidebarViewStore(
  createLocalSessionSidebarViewStorage()
)
announceArchiveChanges(useSessionSidebarView, emitConversationArchiveChange)
