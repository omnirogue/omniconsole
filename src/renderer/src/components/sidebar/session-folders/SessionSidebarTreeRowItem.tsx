import { useLaunchIntentDrop } from './use-launch-intent-drop'
import { memo, useCallback } from 'react'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  writeSessionSidebarDrag
} from '@/lib/session-sidebar-drag'
import { sessionWorkspaceGroupKey, type SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { isLedgerOnlyRow, isOwnerPlacedRow } from '@/lib/mirrored-conversation-row-actions'
import type { PursuitSidebarTreeRow } from '@/lib/session-sidebar-tree-rows'
import type { SessionFolderColor } from '@/lib/session-folder-colors'
import { SessionSidebarRow } from './SessionSidebarRow'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { sessionWorkersKey } from '@/lib/session-sidebar-worker-keys'
import { cn } from '@/lib/utils'
import { sessionSidebarDragBatch } from './session-sidebar-batch'

/** Row actions shared by every row of a group; the object is stable for the group's life. */
export type SessionTreeRowHandlers = {
  select?: (session: SidebarSession, event: React.MouseEvent<HTMLElement>) => boolean
  startChain?: (session: SidebarSession) => void
  rename?: (session: SidebarSession, title: string | null) => void
  open: (session: SidebarSession) => void
  cancelQueue: (session: SidebarSession) => void
  /** Absent where a row drop would mean nothing, such as inside a task group. */
  dropRow?: (source: string, row: SessionSidebarTreeRow) => void
}

type Props = {
  row: SessionSidebarTreeRow
  handlers: SessionTreeRowHandlers
  technical?: boolean
  current: boolean
  onScreen?: boolean
  selected: boolean
  focused?: boolean
  queued: boolean
  chain: SessionChainRowInfo | null
  now?: number
  color?: SessionFolderColor | null
  putAway?: boolean
}

/**
 * Binds one tree row's callbacks here so the list hands down only stable values; with
 * structural sharing an unchanged row then skips its render entirely.
 */
export const SessionSidebarTreeRowItem = memo(function SessionSidebarTreeRowItem({
  row,
  handlers,
  technical,
  current,
  onScreen,
  selected,
  focused,
  queued,
  chain,
  now,
  color = null,
  putAway = false
}: Props): React.JSX.Element {
  const { session } = row
  // Why (E1/F13): a row the owner's ledger created is renamed and filed on its owner, not here;
  // a row the owner places (its ledger states a folder) is filed there too, so it is not dragged.
  const ledgerOnly = isLedgerOnlyRow(session)
  const ownerPlaced = isOwnerPlacedRow(session)
  const launchDrop = useLaunchIntentDrop(
    session.workflow ? undefined : { worktreeId: session.worktreeId }
  )
  const { select, startChain, rename, open, cancelQueue, dropRow } = handlers
  const onSelect = useCallback(
    (event: React.MouseEvent<HTMLElement>) => select?.(session, event) ?? false,
    [select, session]
  )
  const onStartChain = useCallback(() => startChain?.(session), [startChain, session])
  const onRename = useCallback(
    (title: string | null) => rename?.(session, title),
    [rename, session]
  )
  const onOpen = useCallback(() => open(session), [open, session])
  const onCancelQueue = useCallback(() => cancelQueue(session), [cancelQueue, session])
  const onDropRow = useCallback((source: string) => dropRow?.(source, row), [dropRow, row])
  const onOpenSeat = useCallback((seat: PursuitSidebarTreeRow) => open(seat.session), [open])
  const onToggleWorkers = useCallback(
    () =>
      useSessionSidebarView
        .getState()
        .toggleCollapsed(sessionWorkersKey(conversationViewKey(session))),
    [session]
  )
  const onDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const key = conversationViewKey(session)
      event.dataTransfer.effectAllowed = 'move'
      writeSessionSidebarDrag(event.dataTransfer, { kind: 'row', sessionKey: key })
      // Why: dragging a selected row carries the whole selection — sessions and folders.
      const batch = sessionSidebarDragBatch({ sessionKey: key })
      beginSessionSidebarDrag({
        kind: 'row',
        sessionKey: key,
        workspaceGroupKey: sessionWorkspaceGroupKey(session),
        ...(batch ? { batch } : {})
      })
    },
    [session]
  )
  return (
    <div
      className={cn(
        'min-w-0 rounded-md data-[drag-over=true]:ring-1 data-[drag-over=true]:ring-ring',
        // Why: a worker listed under its launcher reads as inside it.
        row.workerOf && 'ml-3 border-l border-worktree-sidebar-border pl-1'
      )}
      data-session-worker-of={row.workerOf}
      data-drag-over={launchDrop.over}
      onDragOverCapture={launchDrop.onDragOver}
      onDropCapture={launchDrop.onDrop}
      onDragLeave={launchDrop.onDragLeave}
    >
      <SessionSidebarRow
        unreadCompletion={row.unreadCompletion}
        activityUnverifiable={row.activityUnverifiable}
        pursuitState={row.pursuitState}
        session={session}
        technical={technical}
        current={current}
        onScreen={onScreen}
        selected={selected}
        focused={focused}
        onSelect={select ? onSelect : undefined}
        queued={queued}
        chain={chain}
        pursuitChain={row.pursuitChain ?? null}
        run={row.run ?? null}
        seats={row.children}
        onOpenSeat={onOpenSeat}
        workers={row.workers}
        subagent={row.subagent}
        workerDispatchId={row.workerDispatchId}
        workerProcessIncarnation={row.workerProcessIncarnation}
        onToggleWorkers={row.workers ? onToggleWorkers : undefined}
        onStartChain={startChain ? onStartChain : undefined}
        state={row.state}
        backgroundTaskCount={row.backgroundTaskCount}
        attention={row.attention}
        returned={row.returned}
        planNeedsYou={row.planNeedsYou}
        waitingUntil={row.waitingUntil}
        locked={row.locked}
        completed={row.completed}
        archived={row.archived}
        putAway={putAway}
        color={color}
        now={now}
        onOpen={onOpen}
        onRename={rename && session.tabId && !ledgerOnly ? onRename : undefined}
        onCancelQueue={onCancelQueue}
        onDragStart={ownerPlaced ? undefined : onDragStart}
        onDropRow={dropRow ? onDropRow : undefined}
        onDragEnd={clearSessionSidebarDrag}
      />
    </div>
  )
})
