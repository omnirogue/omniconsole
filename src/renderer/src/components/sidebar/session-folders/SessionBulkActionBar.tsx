import { useRef, useState } from 'react'
import { Archive, EyeOff, FolderInput, FolderPlus, MoreVertical, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import { withoutLedgerOnlyRows } from '@/lib/mirrored-conversation-row-actions'
import { movableBulkItems } from '@/lib/session-move-owner-guard'
import type { SessionFolder } from '@/lib/session-folders'
import { sessionFolderPath, sessionFolderTree } from '@/lib/session-folder-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'
import type { ConversationFleetSidebarRow } from '@/lib/conversation-fleet-sidebar'
import type { RoutineCommands } from '../routines/routine-row-commands'
import { routineHiddenKey } from '../routines/routine-view-key'
import {
  hideSessionsByPerson,
  moveSessionsByPerson
} from '@/lib/session-organization-person-changes'
import { offerProjectContext } from '@/lib/session-project-context-offer'
import { setRoutineRowsHidden } from './sidebar-group-and-routine-hiding'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionFolderNamePopover } from './SessionFolderNamePopover'
import { SessionBulkAttachToTask } from './SessionBulkAttachToTask'
import { SessionBulkPutToSleep } from './SessionBulkPutToSleep'
import { SessionBulkActions } from './SessionBulkActions'
import { selectedBulkSources, SessionBulkOwnerNotice } from './SessionBulkOwnerSelection'
import { SessionBulkSelectedCount } from './SessionBulkSelectedCount'
import { SessionBulkNextStep, type SessionBulkItem } from './SessionBulkNextStep'
import { useDeleteSidebarSessions } from './session-delete'
import { sessionFolderBulkDeletePlan } from './session-folder-bulk-delete'
import { useSessionFolderBulkDelete } from './use-session-folder-bulk-delete'
import { archiveCleanupRows, fleetCleanupRows, pauseCleanupRoutines } from './sidebar-cleanup-rows'
import {
  succeededSessionKeys,
  toastSessionBulkOutcomes,
  type SessionBulkOutcome
} from './session-bulk-outcome'

const NO_ROUTINES: readonly ConversationRoutineRow[] = []
const NO_FLEET: readonly ConversationFleetSidebarRow[] = []
const NO_FOLDERS: readonly string[] = []

type BulkAction = 'archive' | 'hide' | 'move' | 'delete'

function sameOutcome(
  items: readonly Pick<SessionBulkItem, 'key' | 'label'>[],
  ok: boolean,
  message?: string
): SessionBulkOutcome[] {
  return items.map((item) => ({ key: item.key, label: item.label, ok, message }))
}

/**
 * Actions over the selected conversations. Each button says how many of the selection it can
 * act on, runs the eligible ones one after another, reports one summary toast, and drops
 * only what succeeded from the selection so the rest can be retried or inspected.
 */
export function SessionBulkActionBar({
  sessions,
  routines = NO_ROUTINES,
  fleetRows = NO_FLEET,
  routineCommands,
  folders,
  folderIds = NO_FOLDERS,
  queuedRowKeys,
  onCreateFolder,
  onClear,
  onCompleted
}: {
  /** The selection in displayed order. */
  sessions: readonly SidebarSession[]
  /** Routines in the selection: they archive, hide and move with the conversations. */
  routines?: readonly ConversationRoutineRow[]
  fleetRows?: readonly ConversationFleetSidebarRow[]
  /** Pauses a routine as it is archived, as the row's own Archive does. */
  routineCommands?: Pick<RoutineCommands, 'setEnabled'>
  folders: readonly SessionFolder[]
  /** Folders picked on their heading; Delete removes them (their sessions move up). */
  folderIds?: readonly string[]
  queuedRowKeys: ReadonlySet<string>
  onCreateFolder: (name: string) => string | null
  onClear: () => void
  /** Keys whose action succeeded; the caller removes them from the selection. */
  onCompleted: (keys: readonly string[]) => void
}): React.JSX.Element {
  const deleteSessions = useDeleteSidebarSessions()
  const deleteWithFolders = useSessionFolderBulkDelete()
  const archived = useSessionSidebarView((state) => state.archived)
  const hiddenKeys = useSessionSidebarView((state) => state.view.hidden)
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // Why a ref: the menu's close-focus handler runs after the item fires, and must know the editor just opened.
  const newFolderStartedRef = useRef(false)
  // Why (E1/F13): a row the owner's ledger created runs there, so no bulk action changes it here.
  const selectedSessions = selectedBulkSources(sessions, fleetRows)
  const sourceSessions = withoutLedgerOnlyRows(selectedSessions)
  const fleetItems = fleetCleanupRows(fleetRows.filter((row) => !row.source))
  const items: SessionBulkItem[] = sourceSessions.map((session) => ({
    key: conversationViewKey(session),
    label: session.label,
    session
  }))
  const routineItems = routines.map((row) => ({
    key: row.key,
    label: row.automation.name,
    row
  }))
  const archivableRoutines = routineItems.filter((item) => !archived.includes(item.key))
  const hideableRoutines = routineItems.filter(
    (item) => !hiddenKeys.includes(routineHiddenKey(item.key))
  )
  const archivable = [
    ...items.filter((item) => !archived.includes(item.key)),
    ...fleetItems.filter((item) => !archived.includes(item.key)),
    ...archivableRoutines
  ]
  const hideable = [
    ...items.filter((item) => !hiddenKeys.includes(`conversation:${item.key}`)),
    ...fleetItems.filter((item) => !hiddenKeys.includes(`conversation:${item.key}`)),
    ...hideableRoutines
  ]
  // Why (E1 for filing): a row its paired owner places is filed there, so Move leaves it out.
  const movable = [...movableBulkItems(items), ...routineItems]
  const selectedCount = selectedSessions.length + routineItems.length + fleetItems.length
  const deletable = [...items, ...fleetItems, ...routineItems]
  const pickedFolderCount = sessionFolderBulkDeletePlan({ folders, membership: {} }, folderIds)
    .topIds.length
  const sendable = items.filter(
    (item) =>
      item.session.kind === 'terminal' &&
      item.session.paneKey &&
      !item.session.unavailable &&
      !queuedRowKeys.has(item.session.rowKey)
  )

  const finish = (action: string, outcomes: readonly SessionBulkOutcome[]): void => {
    toastSessionBulkOutcomes(action, outcomes)
    onCompleted(succeededSessionKeys(outcomes))
  }
  const archive = async (): Promise<void> => {
    setBusy('archive')
    try {
      const routineKeys = new Set(routineItems.map((item) => item.key))
      const completed = new Set(
        await archiveCleanupRows(
          archivable.filter((item) => !routineKeys.has(item.key)).map((item) => item.key),
          archivableRoutines.map((item) => item.row),
          routineCommands
        )
      )
      finish(
        translate('conversations.bulkActionArchive', 'Archived'),
        archivable.map((item) => ({
          key: item.key,
          label: item.label,
          ok: completed.has(item.key)
        }))
      )
    } finally {
      setBusy(null)
    }
  }
  const hide = (): void => {
    const routineKeys = new Set(hideableRoutines.map((item) => item.key))
    setRoutineRowsHidden([...routineKeys], true)
    // Why one change: every selected session is one recorded hide with one Undo.
    hideSessionsByPerson(
      hideable.filter((item) => !routineKeys.has(item.key)).map((item) => item.key),
      true
    )
    finish(translate('conversations.bulkActionHide', 'Hidden'), sameOutcome(hideable, true))
  }
  const move = (folderId: string | null): void => {
    const keys = movable.map((item) => item.key)
    const moved = moveSessionsByPerson(keys, folderId)
    if (moved) {
      offerProjectContext(keys, folderId)
    }
    finish(
      translate('conversations.bulkActionMove', 'Moved'),
      sameOutcome(
        movable,
        moved,
        moved ? undefined : (useSessionFolders.getState().error ?? undefined)
      )
    )
  }
  // Why: every selected conversation deletes — archived, hidden and already-closed ones too.
  const remove = (): Promise<void> =>
    deleteWithFolders({
      folderIds,
      sessionKeys: deletable.map((item) => item.key),
      deleteSessions: () =>
        deleteSessions(
          sourceSessions,
          async () => {
            const paused = await pauseCleanupRoutines(routines, routineCommands)
            return [
              ...fleetItems,
              ...paused.map((row) => ({ key: row.key, label: row.automation.name }))
            ]
          },
          onCompleted
        ),
      onBusy: (on) => setBusy(on ? 'delete' : null)
    })
  return (
    <div
      role="toolbar"
      aria-label={translate('conversations.bulkToolbar', 'Selected conversations')}
      data-session-bulk-bar={selectedCount}
      className="worktree-sidebar-scrollbar relative max-h-48 shrink-0 overflow-y-auto space-y-1.5 border-t border-worktree-sidebar-border px-2 py-1.5"
    >
      <div className="flex items-center justify-between gap-2 text-xs font-medium">
        <SessionBulkSelectedCount
          busy={busy !== null}
          rows={selectedCount}
          folders={pickedFolderCount}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={translate('conversations.clearSelection', 'Clear selection')}
          onClick={onClear}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <SessionBulkOwnerNotice sessions={selectedSessions} />
      <div className="flex flex-wrap gap-1">
        {/* Why: with only folders picked, the session actions have nothing to act on. */}
        {selectedCount > 0 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              disabled={busy !== null || archivable.length === 0}
              data-session-bulk-action="archive"
              onClick={() => void archive()}
            >
              <Archive className="size-3" />
              {translate('conversations.bulkArchive', 'Archive ({{count}})', {
                count: archivable.length
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              disabled={busy !== null || hideable.length === 0}
              data-session-bulk-action="hide"
              onClick={hide}
            >
              <EyeOff className="size-3" />
              {translate('conversations.bulkHide', 'Hide ({{count}})', { count: hideable.length })}
            </Button>
            <SessionBulkPutToSleep
              items={items}
              disabled={busy !== null}
              onFinished={(outcomes) =>
                finish(translate('conversations.bulkActionSleep', 'Put to sleep'), outcomes)
              }
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              disabled={busy !== null || movable.length === 0}
              data-session-bulk-action="create-folder"
              onClick={() => setNewFolderOpen(true)}
            >
              <FolderPlus className="size-3" />
              {translate('chatActions.createFolder', 'Create Folder')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="gap-1"
                  disabled={busy !== null || movable.length === 0}
                  data-session-bulk-action="move"
                >
                  <FolderInput className="size-3" />
                  {translate('conversations.bulkMove', 'Move to folder ({{count}})', {
                    count: movable.length
                  })}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                onCloseAutoFocus={(event) => {
                  if (newFolderStartedRef.current) {
                    newFolderStartedRef.current = false
                    event.preventDefault()
                  }
                }}
              >
                {sessionFolderTree(folders).map(({ folder }) => (
                  <DropdownMenuItem key={folder.id} onSelect={() => move(folder.id)}>
                    {sessionFolderPath(folders, folder)}
                  </DropdownMenuItem>
                ))}
                {folders.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => move(null)}>
                  {translate('auto.components.SessionSidebar.unfiled', 'Unfiled')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    newFolderStartedRef.current = true
                    setNewFolderOpen(true)
                  }}
                >
                  {translate('conversations.bulkNewFolder', 'New folder…')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SessionFolderNamePopover
              folders={folders}
              open={newFolderOpen}
              onOpenChange={setNewFolderOpen}
              onSave={(name) => {
                const id = onCreateFolder(name)
                if (id === null) {
                  return false
                }
                move(id)
                return true
              }}
            >
              {/* Why: an invisible anchor lets the folder editor open from the menu while positioning against the bar. */}
              <span aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 w-px" />
            </SessionFolderNamePopover>
            <SessionBulkAttachToTask
              items={items}
              disabled={busy !== null}
              onFinished={(outcomes) =>
                finish(translate('conversations.bulkActionAddToTask', 'Added to task'), outcomes)
              }
            />
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={translate('nextStep.moreOptions', 'More options')}
                  aria-haspopup="menu"
                >
                  <MoreVertical className="size-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="right" align="start" className="w-56 space-y-1 p-1" role="menu">
                <SessionBulkActions compact />
                <SessionBulkNextStep
                  dispatch
                  items={sendable}
                  disabled={busy !== null}
                  label={translate('conversations.bulkDispatch', 'Dispatch ({{count}})', {
                    count: sendable.length
                  })}
                  onFinished={(outcomes) => {
                    setMoreOpen(false)
                    finish(translate('conversations.bulkActionDispatch', 'Dispatched'), outcomes)
                  }}
                />
              </PopoverContent>
            </Popover>
            <SessionBulkNextStep
              dispatch={false}
              items={sendable}
              disabled={busy !== null}
              label={translate('conversations.bulkSendToHuman', 'Send to human ({{count}})', {
                count: sendable.length
              })}
              onFinished={(outcomes) =>
                finish(
                  translate('conversations.bulkActionSendToHuman', 'Sent to a person'),
                  outcomes
                )
              }
            />
          </>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1 text-destructive hover:text-destructive"
          disabled={busy !== null || deletable.length + pickedFolderCount === 0}
          data-session-bulk-action="delete"
          onClick={() => void remove()}
        >
          <Trash2 className="size-3" />
          {translate('conversations.bulkDelete', 'Delete ({{count}})', {
            count: deletable.length + pickedFolderCount
          })}
        </Button>
      </div>
    </div>
  )
}
