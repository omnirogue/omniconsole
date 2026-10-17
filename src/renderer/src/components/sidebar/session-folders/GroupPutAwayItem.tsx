import { useMemo, useRef, useState } from 'react'
import { Archive, Trash2 } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import { sessionRowFolderId } from '@/lib/mirrored-conversation-folders'
import { withoutLedgerOnlyRows } from '@/lib/mirrored-conversation-row-actions'
import { sessionFolderSubtreeIds } from '@/lib/session-folder-tree'
import {
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { Button } from '@/components/ui/button'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useDeleteSidebarSessions } from './session-delete'
import { useSidebarSessions } from './use-sidebar-sessions'
import {
  archiveCleanupRows,
  fleetCleanupRows,
  pauseCleanupRoutines,
  type SidebarCleanupGroup
} from './sidebar-cleanup-rows'
import type { RoutineCommands } from '../routines/routine-row-commands'

/** The folder ids a folder group holds, subfolders included; null for a status group. */
function groupFolderIds(
  group: Pick<SessionSidebarGroup, 'kind' | 'folder'>,
  folders: readonly SessionFolder[]
): Set<string> | null {
  if (group.kind === 'saved') {
    return new Set([
      SAVED_SESSIONS_FOLDER_ID,
      ...folders.filter((folder) => folder.section === 'saved').map((folder) => folder.id)
    ])
  }
  return group.folder ? sessionFolderSubtreeIds(folders, group.folder.id) : null
}

/**
 * The rows a folder group's put-away acts on: the ones the tree shows in it or its subfolders.
 * Why the tree's resolver (C3): a paired owner's explicit folder places its row, so a local
 * membership the tree does not show must neither count here nor archive that conversation on
 * its owner from a folder the person never saw it in.
 */
export function groupPutAwayFolderRows<T extends SidebarSession>(
  all: readonly T[],
  metadata: SessionFolderMetadata,
  folderIds: ReadonlySet<string>,
  deleted: ReadonlySet<string>
): T[] {
  return withoutLedgerOnlyRows(
    all.filter((session) => {
      const key = conversationViewKey(session)
      const folderId = sessionRowFolderId(metadata, session, key)
      return folderId !== null && folderIds.has(folderId) && (session.tabId || !deleted.has(key))
    })
  )
}

/**
 * The one-click "put all of it away" on a group's ⋯, Mac-Trash style: under Archived it is
 * "Delete all"; everywhere else it is "Archive all" — for a folder, its subfolders too, folded
 * or not (the folders themselves stay). Archived also exposes this directly on its heading.
 */
export function GroupPutAwayItem({
  group,
  folders,
  routineCommands,
  inline = false
}: {
  group: SidebarCleanupGroup
  folders: readonly SessionFolder[]
  routineCommands?: Pick<RoutineCommands, 'setEnabled'>
  inline?: boolean
}): React.JSX.Element | null {
  const all = useSidebarSessions()
  const metadata = useSessionFolders((state) => state.metadata)
  const deleted = useSessionSidebarView((state) => state.view.deleted)
  const archivedKeys = useSessionSidebarView((state) => state.archived)
  const deleteSessions = useDeleteSidebarSessions()
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const emptying = group.kind === 'archived'
  // Why (E1/F13): a row the owner's ledger created is archived and deleted on its owner, so the
  // group's put-away leaves it where it is and does not count it.
  const sessions = useMemo(() => {
    const ids = groupFolderIds(group, folders)
    if (!ids) {
      return withoutLedgerOnlyRows([
        ...group.rows.map((row) => row.session),
        ...(group.fleetRows ?? []).flatMap((row) => (row.source ? [row.source] : []))
      ])
    }
    return groupPutAwayFolderRows(all, metadata, ids, new Set(deleted ?? []))
  }, [all, deleted, folders, group, metadata])
  const archivable = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !(session.ownerArchive?.archived ?? archivedKeys.includes(conversationViewKey(session)))
      ),
    [archivedKeys, sessions]
  )
  const fleetRows = fleetCleanupRows((group.fleetRows ?? []).filter((row) => !row.source))
  const routines = group.routineRows ?? []
  const count = new Set([
    ...sessions.map(conversationViewKey),
    ...fleetRows.map((row) => row.key),
    ...routines.map((row) => row.key)
  ]).size
  const remove = async (): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      await deleteSessions(sessions, async () => {
        const paused = await pauseCleanupRoutines(routines, routineCommands)
        return [
          ...fleetRows,
          ...paused.map((row) => ({ key: row.key, label: row.automation.name }))
        ]
      })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  if (emptying) {
    if (inline) {
      return count === 0 ? null : (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-destructive hover:text-destructive"
          data-session-empty-archive=""
          disabled={busy}
          onClick={() => void remove()}
        >
          <Trash2 className="size-3.5" />
          {translate('conversations.emptyArchive', 'Empty archive')}
        </Button>
      )
    }
    return count === 0 ? null : (
      <DropdownMenuItem
        data-session-group-delete-all=""
        disabled={busy}
        className="text-destructive focus:text-destructive"
        onSelect={() => void remove()}
      >
        <Trash2 className="size-3.5" />
        {translate('conversations.deleteAllInGroup', 'Delete all ({{count}})', {
          count
        })}
      </DropdownMenuItem>
    )
  }
  const routineCandidates = routines.filter((row) => !archivedKeys.includes(row.key))
  const archiveKeys = [
    ...archivable.map(conversationViewKey),
    ...fleetRows.filter((row) => !archivedKeys.includes(row.key)).map((row) => row.key)
  ]
  if (archiveKeys.length + routineCandidates.length === 0) {
    return null
  }
  return (
    <DropdownMenuItem
      data-session-group-archive-all=""
      onSelect={() => void archiveCleanupRows(archiveKeys, routineCandidates, routineCommands)}
    >
      <Archive className="size-3.5" />
      {translate('conversations.archiveAllInGroup', 'Archive all ({{count}})', {
        count: archiveKeys.length + routineCandidates.length
      })}
    </DropdownMenuItem>
  )
}
