import { memo, useId, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useSessionSelection } from '@/store/session-selection'
import { useAppStore } from '@/store'
import { sessionTechnicalDetail } from './session-technical-detail'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { hideSessionsByPerson } from '@/lib/session-organization-person-changes'
import { useSessionHistoryOpen } from '@/store/session-history-open'
import { conversationViewKey, isPersonalRowHidden } from '@/lib/conversation-view'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { conversationState } from '@/lib/conversation-state'
import { isSessionRowExpanded, sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { showsSessionActivityOnRow } from '@/components/session-activity/session-activity'
import { useSessionActivity } from '@/components/session-activity/use-session-activity'
import { SessionSidebarRowActions } from './SessionSidebarRowActions'
import { SessionSidebarRowDetails } from './SessionSidebarRowDetails'
import { SessionSidebarRowExpandToggle } from './SessionSidebarRowExpandToggle'
import { SessionSidebarRowHoverDetails } from './SessionSidebarRowHoverDetails'
import { SessionSidebarRowCluster } from './SessionSidebarRowCluster'
import { sessionRowIndicator } from './SessionSidebarRowIndicator'
import { SessionSidebarRowLabel } from './SessionSidebarRowLabel'
import { SessionSidebarRowRename } from './SessionSidebarRowRename'
import {
  hasSessionRowDetails,
  queueRefusalText,
  sessionRowDetailNotes,
  sessionRowStatus
} from './session-row-status'
import { useLaunchedSessionPlan } from '@/lib/session-chain-registry'
import { useSessionRowDrop } from './use-session-row-drop'
import { SessionRowHoverCard } from './SessionRowHoverCard'
import { ROW_NAME_FLOOR, ROW_NAME_FLOOR_WORKFLOW } from './session-row-reveal'
import type { SessionSidebarRowProps } from './session-sidebar-row-props'
import { cn } from '@/lib/utils'
import { sessionRowTone } from '@/lib/session-row-tone'
import { sessionFolderColorVar } from '@/lib/session-folder-colors'
import { SessionRowArchivedDate } from './SessionRowArchivedDate'
import { SessionRowWorkersToggle } from './SessionRowWorkersToggle'
import { SessionRowFolderChip } from './SessionRowFolderChip'
import { NextStepsSessionBadge } from '@/components/next-steps/NextStepsSessionBadge'
import { useSessionSearchActive } from './session-search-preview-context'
import { getSessionOwnershipUnverifiedReason } from '@/lib/session-ownership-verdict'
import { sessionRowOpenLabel, useSessionRowHostLabel } from './use-session-row-host-label'
import { ledgerOnlyRowRefusal } from '@/lib/mirrored-conversation-row-actions'

const NO_SSH_LABELS: ReadonlyMap<string, string> = new Map()

/** A popover or menu opened from this row: Radix marks its trigger expanded while it is up. */
const OPEN_ROW_MENU = '[aria-haspopup][aria-expanded="true"]'

export const SessionSidebarRow = memo(function SessionSidebarRow({
  session,
  pursuitState,
  activityUnverifiable = false,
  unreadCompletion = false,
  technical = false,
  current,
  onScreen = false,
  queued,
  chain = null,
  pursuitChain = null,
  run = null,
  seats,
  onOpenSeat,
  workers,
  subagent = false,
  workerDispatchId,
  workerProcessIncarnation,
  onToggleWorkers,
  state = null,
  attention = null,
  returned = false,
  planNeedsYou = false,
  backgroundTaskCount,
  waitingUntil = null,
  locked = null,
  completed = null,
  archived = false,
  putAway = false,
  color = null,
  selected: selectedOverride,
  focused,
  onOpen,
  onSelect,
  onRename,
  onCancelQueue,
  onStartChain,
  onDropRow,
  onDragStart,
  onDragEnd,
  now
}: SessionSidebarRowProps) {
  const selectionKey = conversationViewKey(session)
  // Why: narrow selectors returning primitives, so a store change re-renders only rows it flips.
  const sharedSelected = useSessionSelection((state) => state.selected.has(selectionKey))
  const selected = selectedOverride ?? sharedSelected
  const sshTargetLabels = useAppStore((state) =>
    technical ? state.sshTargetLabels : NO_SSH_LABELS
  )
  const runtimeEnvironments = useAppStore((state) =>
    technical ? state.runtimeEnvironments : undefined
  )
  const key = selectionKey
  const agentLine = technical
    ? sessionTechnicalDetail(session, sshTargetLabels, runtimeEnvironments)
    : session.agent
  const hidden = useSessionSidebarView((state) => isPersonalRowHidden(state.view, session))
  // Why: one line per row by default; the agent and status lines come back only when asked for.
  // A search result is always one line, with at most the matching passage under it.
  const searching = useSessionSearchActive()
  const compact =
    useSessionSidebarView((state) => sessionSidebarDensity(state.view) === 'compact') || searching
  const hostLabel = useSessionRowHostLabel(session)
  const launchedBy = useLaunchedSessionPlan(session.paneKey, session)
  // Why: a quarantined row is labelled, never hidden; the selector returns a primitive reason.
  const ownershipUnverified = useAppStore((state) =>
    getSessionOwnershipUnverifiedReason(state, session)
  )
  // Why (E1/F13): a row the owner's ledger created runs there: no queue or batch acts on it here.
  const ledgerRefusal = ledgerOnlyRowRefusal(session)
  const canQueue = session.kind === 'terminal' && Boolean(session.paneKey) && !session.unavailable
  const queueRefusal = ledgerRefusal ?? (canQueue ? null : queueRefusalText(session))
  const [renaming, setRenaming] = useState(false)
  const openRef = useRef<HTMLButtonElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const renameTo = onRename && !session.unavailable ? onRename : undefined
  const editingName = renaming && renameTo !== undefined
  // Why: selecting text in the name field must not pick the row up.
  const draggable = Boolean(onDragStart) && !editingName
  // Why: only a request, a plan handed back, or an ordinary pane's own question lights a row up;
  // a failed, recovering, waiting or finished run never does.
  const needsYou = attention !== null || returned || planNeedsYou
  const visualState =
    pursuitState ??
    conversationState({
      state,
      needsYou,
      waiting: waitingUntil !== null
    })
  const statusInput = {
    activityUnverifiable,
    ownershipUnverified,
    monitoring: state === 'monitoring',
    backgroundTaskCount,
    session,
    chain,
    pursuitChain,
    run,
    attention,
    returned,
    waitingUntil,
    locked,
    queued,
    completed,
    archived,
    now
  }
  const status = sessionRowStatus(statusInput)
  const notes = sessionRowDetailNotes(statusInput, status)
  // Why here: the step or the current activity is the row's line only when nothing asks,
  // blocks, sleeps or queues; otherwise it moves into the details with everything else.
  const activity = useSessionActivity({ paneKey: session.paneKey, launchedBy })
  const activityLine = showsSessionActivityOnRow(activity) ? activity.line : null
  const hasDetails =
    hasSessionRowDetails(statusInput, notes) || (status !== null && activityLine !== null)
  const historyOpen = useSessionHistoryOpen((state) => state.open.has(key))
  const expanded =
    useSessionSidebarView((state) => hasDetails && isSessionRowExpanded(state.view, key)) ||
    historyOpen
  const detailsId = useId()
  const indicator = compact
    ? sessionRowIndicator({ needsYou, visualState, waitingUntil, locked, chain, launchedBy })
    : null
  const drop = useSessionRowDrop(onDropRow)
  const tone = sessionRowTone({ visualState, needsYou, putAway: putAway || archived })
  const asks = needsYou || tone === 'needs-you'
  return (
    <>
      <div
        ref={rowRef}
        role={onSelect ? 'option' : undefined}
        aria-selected={onSelect ? selected : undefined}
        className={cn(
          'group flex items-center rounded-md text-worktree-sidebar-foreground hover:bg-worktree-sidebar-accent',
          // Why: the state reads from the row's tint before a word of it is read — green while
          // it works, muted blue while it waits, grey once stopped; done stays the list's own
          // background. A row with no such state takes its folder's color.
          tone === 'active' && 'bg-session-tone-active/10 hover:bg-session-tone-active/15',
          tone === 'waiting' && 'bg-session-tone-waiting/10 hover:bg-session-tone-waiting/15',
          tone === 'stopped' && 'bg-session-tone-stopped/15 hover:bg-session-tone-stopped/20',
          tone === null &&
            color !== null &&
            'bg-[color-mix(in_srgb,var(--session-row-color)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--session-row-color)_16%,transparent)]',
          // Why: a session waiting on the user must read at a glance, even inside a folded-open group.
          asks &&
            'bg-session-tone-needs-you/15 ring-1 ring-inset ring-session-tone-needs-you/40 hover:bg-session-tone-needs-you/20',
          // Why: selection is a ring, the open conversation a fill — one row can be both.
          selected && 'bg-worktree-sidebar-accent/60 ring-1 ring-inset ring-worktree-sidebar-ring',
          // Why last: the conversation on the main screen must out-read hover and selection, so it
          // alone gets a left accent bar and weight, and its full fill wins over selection's tint.
          // Why: every conversation on screen wears the accent bar, so a grid of three reads as three.
          onScreen &&
            !current &&
            'bg-worktree-sidebar-accent/70 shadow-[inset_2px_0_0_0_var(--worktree-sidebar-accent-foreground)]',
          current &&
            'bg-worktree-sidebar-accent font-medium shadow-[inset_2px_0_0_0_var(--worktree-sidebar-accent-foreground)]',
          current && asks && 'bg-session-tone-needs-you/20',
          draggable && 'cursor-grab active:cursor-grabbing'
        )}
        {...drop}
        style={
          color
            ? ({ '--session-row-color': sessionFolderColorVar(color) } as React.CSSProperties)
            : undefined
        }
        data-session-tone={tone ?? undefined}
        data-session-color={color ?? undefined}
        data-current={current || undefined}
        data-on-screen={current || onScreen || undefined}
        data-selected={selected || undefined}
        data-session-key={key}
        data-session-row={session.rowKey}
        data-session-density={compact ? 'compact' : 'comfortable'}
        data-needs-attention={needsYou ? '' : undefined}
        draggable={draggable || undefined}
        onDragStart={draggable ? onDragStart : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
      >
        <Checkbox
          className="ml-1 shrink-0"
          checked={selected}
          disabled={ledgerRefusal !== null}
          title={ledgerRefusal ?? undefined}
          aria-label={translate('sessions.selectSession', 'Select {{session}}', {
            session: session.label
          })}
          onCheckedChange={() =>
            useSessionSelection.getState().toggle(selectionKey, onSelect ? 'visible' : 'all')
          }
        />
        {editingName && renameTo ? (
          <SessionSidebarRowRename
            session={session}
            compact={compact}
            title={session.label}
            visualState={visualState}
            agentLine={agentLine}
            onRename={renameTo}
            onDone={(fromKeyboard) => {
              setRenaming(false)
              if (fromKeyboard) {
                requestAnimationFrame(() => openRef.current?.focus())
              }
            }}
          />
        ) : null}
        <SessionRowHoverCard
          session={session}
          chainId={launchedBy?.chainId ?? chain?.chainId ?? null}
          renderDetails={() => (
            <SessionSidebarRowHoverDetails
              session={session}
              status={status}
              notes={notes}
              activity={activityLine}
              pursuitChain={pursuitChain}
              run={run}
              seats={seats}
              onOpenSeat={onOpenSeat}
              hasDetails={hasDetails}
            />
          )}
          isBusy={() => rowRef.current?.querySelector(OPEN_ROW_MENU) !== null}
        >
          <Button
            ref={openRef}
            hidden={editingName}
            variant="ghost"
            className={cn(
              // Why has-[>svg]:px-2: a workflow row's preset glyph is a bare svg, which would
              // otherwise take the Button's wider icon padding and indent that row alone.
              'h-auto flex-1 justify-start px-2 text-left hover:bg-transparent hover:text-worktree-sidebar-accent-foreground has-[>svg]:px-2',
              ROW_NAME_FLOOR,
              session.workflow && ROW_NAME_FLOOR_WORKFLOW,
              compact ? 'gap-1.5 py-1 leading-tight' : 'gap-2 py-2'
            )}
            onClick={(event) => {
              // Why: a modified click picks rows; only a plain click opens, and it collapses the
              // selection to this row on the way. Neither starts, stops or sends to an agent.
              if (onSelect?.(event)) {
                return
              }
              onOpen()
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'F2' &&
                renameTo &&
                !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
              ) {
                event.preventDefault()
                event.stopPropagation()
                setRenaming(true)
              }
            }}
            disabled={session.unavailable}
            tabIndex={focused === undefined ? undefined : focused ? 0 : -1}
            data-session-open=""
            aria-keyshortcuts={renameTo ? 'F2' : undefined}
            aria-label={sessionRowOpenLabel(session.label, hostLabel)}
          >
            <SessionSidebarRowLabel
              compact={compact}
              session={session}
              subagent={subagent}
              visualState={visualState}
              unreadCompletion={unreadCompletion}
              agentLine={agentLine}
              status={status}
              activityLine={activityLine}
              activitySignal={activity.signal}
              // Why not on a technical comfortable row: its detail line already names the host.
              hostLabel={compact || !technical ? hostLabel : null}
              onStartRename={renameTo ? () => setRenaming(true) : undefined}
            />
          </Button>
        </SessionRowHoverCard>
        {archived ? (
          <SessionRowArchivedDate viewKey={key} finishedAt={completed?.at ?? null} />
        ) : null}
        <SessionRowFolderChip viewKey={key} session={session} />
        {session.unavailable ? null : <NextStepsSessionBadge session={session} onOpen={onOpen} />}
        {workers && onToggleWorkers ? (
          <SessionRowWorkersToggle
            name={session.label}
            workers={workers}
            onToggle={onToggleWorkers}
          />
        ) : null}
        <SessionSidebarRowCluster compact={compact} indicator={indicator}>
          {hasDetails ? (
            <SessionSidebarRowExpandToggle
              name={session.label}
              expanded={expanded}
              detailsId={detailsId}
              onToggle={() => useSessionSidebarView.getState().setRowExpanded(key, !expanded)}
            />
          ) : null}
          <SessionSidebarRowActions
            session={session}
            workerDispatchId={subagent ? workerDispatchId : undefined}
            workerProcessIncarnation={subagent ? workerProcessIncarnation : undefined}
            chain={chain}
            launchedBy={launchedBy}
            queued={queued}
            queueRefusal={queueRefusal}
            hidden={hidden}
            archived={archived}
            onToggleHidden={() => hideSessionsByPerson([key], !hidden)}
            onCancelQueue={onCancelQueue}
            onStartChain={onStartChain}
          />
        </SessionSidebarRowCluster>
      </div>
      {expanded ? (
        <SessionSidebarRowDetails
          id={detailsId}
          session={session}
          notes={notes}
          activity={status !== null ? activityLine : null}
          pursuitChain={pursuitChain}
          run={run}
          seats={seats}
          onOpenSeat={onOpenSeat}
        />
      ) : null}
    </>
  )
})
