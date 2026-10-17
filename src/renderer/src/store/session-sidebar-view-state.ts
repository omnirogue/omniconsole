import type {
  SessionSidebarGroupBy,
  SessionSidebarView,
  SessionSidebarDensity,
  SessionSidebarLayout
} from '@/lib/session-sidebar-view'
import type { SessionSidebarViewChoice } from '@/lib/session-sidebar-view-choice'
import type { SessionSidebarSort } from '@/lib/session-sidebar-sort'
import type { SessionFolderColor } from '@/lib/session-folder-colors'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import type { SessionHostFilter } from '@/lib/session-host-scope'

export type SessionSidebarViewState = {
  view: SessionSidebarView
  /** Conversations the person put away by hand (view keys); they sit under Archived regardless of age. */
  archived: readonly string[]
  loaded: boolean
  archiveStorageReady: boolean
  /** Transient: reveal hidden groups (dimmed) so they can be unhidden. */
  showHidden: boolean
  load: () => void
  setShowHidden: (showHidden: boolean) => void
  toggleCollapsed: (key: string) => void
  setCollapsed: (keys: readonly string[], collapsed: boolean) => void
  setHidden: (key: string, hidden: boolean) => void
  /** Open or close one row's details block; per device, like hidden and archived. */
  setRowExpanded: (key: string, expanded: boolean) => void
  setHiddenMany: (keys: readonly string[], hidden: boolean) => void
  /** `account-sync` marks a change the sync applies, which is not the person's own. */
  setArchived: (
    keys: readonly string[],
    archived: boolean,
    origin?: 'account-sync' | 'resume'
  ) => void
  archiveTransfer: (keys: readonly string[], operationId: string, commit: () => boolean) => void
  readTransferArchiveReceipt: (operationId: string) => readonly string[] | null
  archiveVerified: (key: string, proof: string) => boolean
  /** Delete (or undelete) conversations from the list, by view key. Per device. */
  setDeleted: (keys: readonly string[], deleted: boolean) => void
  /** Color a group (and the rows in it) by group key; null clears it. Per device. */
  setGroupColor: (key: string, color: SessionFolderColor | null) => void
  snooze: (keys: readonly string[], until: number | null) => void
  setCompanyVisible: (key: string, visible: boolean) => void
  setGroupBy: (groupBy: SessionSidebarGroupBy) => void
  /** Which host kinds and hosts the list shows, with what older builds should read; per device. */
  setHostFilter: (filter: SessionHostFilter, hostScope: ExecutionHostScope) => void
  /** One line per row, or title + agent + status line; per device, like groupBy. */
  setDensity: (density: SessionSidebarDensity) => void
  /** The five-line focus view or the full tree; per device, like density. */
  setLayout: (layout: SessionSidebarLayout) => void
  /** The View picker: Focus, Folders or a Group-by view, saved as one choice per device. */
  setViewChoice: (choice: SessionSidebarViewChoice) => void
  /** Row order inside every group; per device. */
  setSort: (sort: SessionSidebarSort) => void
  /**
   * Saved Sessions' eye. On opens every key in `savedKeys` (Saved Sessions and each saved folder);
   * off folds the saved folders back so opening Saved Sessions lists only its folders.
   */
  setSavedShowAll: (on: boolean, savedKeys: readonly string[]) => void
  /** Seconds before an idle open folder folds itself; 0 turns it off. Per device. */
  setAutoCollapseSeconds: (seconds: number) => void
  setDoneArchiveMinutes: (minutes: number) => void
  setDoneArchiveClocks: (clocks: NonNullable<SessionSidebarView['doneArchiveClocks']>) => boolean
  setUnreachableBlankClocks: (
    clocks: NonNullable<SessionSidebarView['unreachableBlankClocks']>
  ) => boolean
  moveRow: (key: string, target: string, keys: readonly string[]) => void
  migrateSessionKey: (from: string, to: string) => void
  moveGroup: (args: {
    key: string
    target: string
    position: 'before' | 'after'
    visibleKeys: readonly string[]
  }) => void
  /** Fold or open one conversation's Outcome / Up next header; per device, like expandedRows. */
  setWorkHeaderCollapsed: (key: string, collapsed: boolean) => void
}
