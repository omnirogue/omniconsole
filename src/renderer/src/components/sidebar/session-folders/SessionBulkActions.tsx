import { SessionTagPicker } from './SessionTagPicker'
import { useEffect, useRef, useState } from 'react'
import { Eye, Pause, Trash2, MoreHorizontal } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useWaitLater } from '@/store/wait-later-store'
import { Button } from '@/components/ui/button'
import { SessionSelectionPicker } from './SessionSelectionPicker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSessionSelection } from '@/store/session-selection'
import {
  archiveSessionsByPerson,
  hideSessionsByPerson,
  moveSessionsByPerson
} from '@/lib/session-organization-person-changes'
import { offerProjectContext } from '@/lib/session-project-context-offer'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  ownerPlacedRowRefusal,
  withoutLedgerOnlyRows,
  withoutOwnerPlacedRows
} from '@/lib/mirrored-conversation-row-actions'
import { isMirroredConversationLedgerKey } from '@/lib/mirrored-sidebar-conversation'
import { sessionFolderPath, sessionFolderTree } from '@/lib/session-folder-tree'
import { pauseSidebarSession } from '@/lib/conversation-fleet-pause'
import { conversationFleetRowKey, conversationFleetSource } from '@/lib/conversation-fleet-sidebar'
import { useConversationFleetRuns } from '@/store/conversation-fleet-store'
import { isRoutineViewKey } from '../routines/routine-view-key'
import { useSidebarSessions } from './use-sidebar-sessions'
import { translate } from '@/i18n/i18n'
import { runSessionBulkAction, type SessionBulkOutcome } from './session-bulk-outcome'
import { SessionBulkResults } from './SessionBulkResults'

export function SessionBulkActions({
  initialKey,
  compact = false
}: {
  initialKey?: string
  compact?: boolean
}) {
  const sessions = useSidebarSessions()
  const fleetRuns = useConversationFleetRuns()
  const selection = useSessionSelection()
  const folders = useSessionFolders()
  const view = useSessionSidebarView()
  const [pending, setPending] = useState(false)
  const running = useRef(false)
  const [report, setReport] = useState<{
    id: number
    action: string
    outcomes: SessionBulkOutcome[]
  } | null>(null)
  const nextReport = useRef(0)
  const selectedKeys = JSON.stringify(selection.keys)
  useEffect(() => setReport(null), [selectedKeys])
  const { loaded: foldersLoaded, load: loadFolders } = folders
  const { loaded: viewLoaded, load: loadView } = view
  useEffect(() => {
    if (!foldersLoaded) {
      loadFolders()
    }
    if (!viewLoaded) {
      loadView()
    }
    if (!useWaitLater.getState().loaded) {
      useWaitLater.getState().load()
    }
    if (initialKey && !useSessionSelection.getState().keys.includes(initialKey)) {
      useSessionSelection.getState().toggle(initialKey)
    }
  }, [foldersLoaded, loadFolders, viewLoaded, loadView, initialKey])
  const unique = [
    ...new Map(sessions.map((session) => [conversationViewKey(session), session])).values()
  ]
  // Why (E1/F13): a row the owner's ledger created runs there, so no bulk action changes it here.
  const selected = withoutLedgerOnlyRows(
    unique.filter((session) => selection.keys.includes(conversationViewKey(session)))
  )
  // Why: a receipt from another computer whose conversation is gone is still selected by its
  // key; it hides and archives with the rest, and Pause reports it cannot reach a source.
  const receipts = fleetRuns
    .map((run) => ({
      run,
      key: conversationFleetRowKey(run, conversationFleetSource(run, unique))
    }))
    .filter(
      ({ key }, index, all) =>
        selection.keys.includes(key) &&
        !selected.some((session) => conversationViewKey(session) === key) &&
        all.findIndex((other) => other.key === key) === index
    )
  const keys = selection.keys.filter(
    (key) =>
      !isRoutineViewKey(key) &&
      !isMirroredConversationLedgerKey(key) &&
      (selected.some((session) => conversationViewKey(session) === key) ||
        receipts.some((receipt) => receipt.key === key))
  )
  const disabled = pending || !keys.length
  const pause = async (): Promise<void> => {
    if (running.current) {
      return
    }
    running.current = true
    setPending(true)
    const id = ++nextReport.current
    setReport({ id, action: translate('sessions.pause', 'Pause'), outcomes: [] })
    try {
      const outcomes = [
        ...(await runSessionBulkAction(
          selected.map((session) => ({
            key: conversationViewKey(session),
            label: session.label,
            session
          })),
          async ({ session }) => {
            const result = await pauseSidebarSession(session)
            return {
              ok: result.state === 'paused' || result.state === 'already-idle',
              skipped: result.state === 'already-idle',
              message: result.message
            }
          }
        )),
        ...receipts.map(({ run, key }) => ({
          key,
          label: run.title,
          ok: false,
          message: translate('conversationFleet.sourceClosed', 'Source conversation closed')
        }))
      ]
      // Dismissal or a new selection must not be undone by a late result.
      setReport((current) => (current?.id === id ? { ...current, outcomes } : current))
    } finally {
      running.current = false
      setPending(false)
    }
  }
  return (
    <div
      className={compact ? 'w-full space-y-2' : 'w-80 max-w-full space-y-3 p-3'}
      aria-label={translate('sessions.bulkActions', 'Session bulk actions')}
    >
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs font-medium">
          {translate('sessions.selectedCount', '{{count}} sessions selected', {
            count: keys.length
          })}
        </p>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || !selection.keys.length}
          onClick={() => selection.set([])}
        >
          {translate('sessions.unselectAll', 'Unselect all')}
        </Button>
      </div>
      <SessionTagPicker sessions={selected} />
      {!compact ? <SessionSelectionPicker sessions={unique} pending={pending} /> : null}
      <div
        role="toolbar"
        aria-label={translate('sessions.bulkActions', 'Session bulk actions')}
        className="grid grid-cols-3 gap-1"
      >
        <Button
          size="xs"
          variant="secondary"
          className="h-auto flex-col gap-1 py-2"
          disabled={disabled}
          onClick={() => hideSessionsByPerson(keys, true)}
        >
          <Eye className="size-3.5" />
          {translate('sessions.hide', 'Hide')}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          className="h-auto flex-col gap-1 py-2"
          disabled={disabled}
          onClick={() => void pause()}
        >
          <Pause className="size-3.5" />
          {translate('sessions.pause', 'Pause')}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          className="h-auto flex-col gap-1 py-2"
          disabled={disabled}
          onClick={() => archiveSessionsByPerson(keys, true)}
        >
          <Trash2 className="size-3.5" />
          {translate('sessions.archive', 'Archive')}
        </Button>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="xs" variant="ghost">
            <MoreHorizontal className="size-3.5" />
            {translate('sessions.moreActions', 'More actions')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 space-y-2 p-3" align="start">
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="secondary"
              disabled={disabled}
              onClick={() => hideSessionsByPerson(keys, false)}
            >
              {translate('sessions.show', 'Show')}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={disabled}
              onClick={() => archiveSessionsByPerson(keys, false)}
            >
              {translate('sessions.unarchive', 'Unarchive')}
            </Button>
          </div>
          <Select
            disabled={disabled || !folders.loaded}
            value=""
            onValueChange={(folder) => {
              // Why one change: the whole selection is one recorded move with one Undo. A row
              // its paired owner places is filed there (E1), so it is reported, not moved.
              const movable = withoutOwnerPlacedRows(selected)
              const keys = movable.map((session) => conversationViewKey(session))
              const folderId = folder === 'unfiled' ? null : folder
              const moved = keys.length === 0 || moveSessionsByPerson(keys, folderId)
              if (moved && keys.length > 0) {
                offerProjectContext(keys, folderId)
              }
              const failures = moved ? [] : movable
              const placed = selected.filter((session) => !movable.includes(session))
              setReport(
                failures.length + placed.length
                  ? {
                      id: ++nextReport.current,
                      action: translate('sessions.move', 'Move'),
                      outcomes: [
                        ...failures.map((session) => ({
                          key: conversationViewKey(session),
                          label: session.label,
                          ok: false,
                          message: translate(
                            'sessions.moveFailed',
                            'Could not save folder assignment.'
                          )
                        })),
                        ...placed.map((session) => ({
                          key: conversationViewKey(session),
                          label: session.label,
                          ok: false,
                          message: ownerPlacedRowRefusal(session) ?? ''
                        }))
                      ]
                    }
                  : null
              )
            }}
          >
            <SelectTrigger
              aria-label={translate(
                'auto.components.SessionSidebar.moveToFolder',
                'Move to folder'
              )}
            >
              <SelectValue
                placeholder={translate(
                  'auto.components.SessionSidebar.moveToFolder',
                  'Move to folder'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unfiled">
                {translate('auto.components.SessionSidebar.unfiled', 'Unfiled')}
              </SelectItem>
              {sessionFolderTree(folders.metadata.folders).map(({ folder }) => (
                <SelectItem key={folder.id} value={folder.id}>
                  {sessionFolderPath(folders.metadata.folders, folder)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PopoverContent>
      </Popover>
      {folders.error ? (
        <p role="alert" className="text-xs text-destructive">
          {folders.error}
        </p>
      ) : null}
      {report ? (
        <SessionBulkResults
          action={report.action}
          outcomes={report.outcomes}
          pending={pending}
          onDismiss={() => setReport(null)}
        />
      ) : null}
    </div>
  )
}
