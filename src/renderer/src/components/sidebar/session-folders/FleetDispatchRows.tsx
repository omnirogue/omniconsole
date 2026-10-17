import { conversationFleetSummary } from '@/lib/conversation-fleet-summary'
import { ConversationStateIcon } from './ConversationStateIcon'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ClipboardCheck,
  FileText,
  MoreVertical,
  PauseCircle,
  Play,
  RotateCcw,
  XCircle
} from 'lucide-react'
import { useAppStore } from '@/store'
import { sessionTechnicalDetail } from './session-technical-detail'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openWorkDecisions } from '@/lib/open-work-decisions'
import { sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { cn } from '@/lib/utils'
import { useSessionSelection } from '@/store/session-selection'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { fleetRunLabel } from '@/components/next-step/FleetDispatchDetails'
import {
  canCancelFleetRun,
  canRetryFleetRun,
  FleetDispatchCancelDialog,
  useFleetStageRetry
} from '@/components/next-step/FleetDispatchControls'
import { UpNextControls } from '@/components/next-action/UpNextControls'
import { pauseSidebarSession } from '@/lib/conversation-fleet-pause'
import { conversationFleetProgress, fleetRunPersonActions } from '@/lib/conversation-fleet-progress'
import {
  conversationFleetRowKey,
  isConversationFleetRowHidden,
  type ConversationFleetSidebarRow
} from '@/lib/conversation-fleet-sidebar'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import {
  archiveSessionsByPerson,
  hideSessionsByPerson
} from '@/lib/session-organization-person-changes'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { ConversationArchiveButton } from './ConversationArchiveButton'
import { PersonalHideButton } from './PersonalHideButton'
import { ConversationRowTitle } from './ConversationRowTitle'
import { ROW_HOVER_REVEAL, ROW_HOVER_YIELD, ROW_NAME_FLOOR } from './session-row-reveal'
import { useSessionSearchActive } from './session-search-preview-context'
import { useFleetDispatchSummary } from './FleetDispatchSummaryProvider'
import { SessionRowHostLabel } from './SessionRowHostLabel'
import { sessionRowOpenLabel, useSessionRowHostLabel } from './use-session-row-host-label'

/** How a receipt row takes part in the list's multi-selection, keyed like a conversation row. */
export type FleetDispatchRowSelection = {
  selectedKeys?: ReadonlySet<string>
  /** The row carrying the roving tabIndex; null when no row does yet. */
  focusKey?: string | null
  /** Returns true when the click was a selection gesture, so the row is not opened. */
  onSelect?: (key: string, event: React.MouseEvent<HTMLElement>) => boolean
}

export function FleetDispatchRows({
  rows,
  technical = false,
  selection,
  onOpenSource
}: {
  technical?: boolean
  rows: readonly ConversationFleetSidebarRow[]
  selection?: FleetDispatchRowSelection
  onOpenSource: (session: SidebarSession) => void
}) {
  return rows.map(({ run, source }) => (
    <FleetDispatchRow
      key={run.workflowId}
      run={run}
      source={source}
      technical={technical}
      selection={selection}
      onOpenSource={onOpenSource}
    />
  ))
}

/** A fleet receipt row with the same lifecycle controls as a conversation row: ☐ 👁 🗄 ⋮ ＋. */
export function FleetDispatchRow({
  run,
  source,
  technical = false,
  selection,
  onOpenSource
}: {
  run: ConversationFleetView
  source: SidebarSession | null
  technical?: boolean
  selection?: FleetDispatchRowSelection
  onOpenSource: (session: SidebarSession) => void
}) {
  const labels = useAppStore((state) => state.sshTargetLabels)
  const runtimeEnvironments = useAppStore((state) =>
    technical ? state.runtimeEnvironments : undefined
  )
  const key = conversationFleetRowKey(run, source)
  // Why: the same key a conversation row selects by, so one selection spans both kinds of row.
  const sharedSelected = useSessionSelection((state) => state.selected.has(key))
  const selected = selection?.selectedKeys?.has(key) ?? sharedSelected
  const onSelect = selection?.onSelect
  const focused = selection?.focusKey === undefined ? undefined : selection.focusKey === key
  const view = useSessionSidebarView((state) => state.view)
  const searching = useSessionSearchActive()
  const compact = sessionSidebarDensity(view) === 'compact' || searching
  // Why the source's: the receipt stands for the conversation that dispatched it, and lists
  // with that conversation's computer (its fleet worker is in the summary).
  const hostLabel = useSessionRowHostLabel(source)
  const archivedByHand = useSessionSidebarView((state) => state.archived.includes(key))
  const hidden = isConversationFleetRowHidden(view, run, source)
  const summaryPanel = useFleetDispatchSummary()
  const detailsOpen = summaryPanel.openWorkflowId === run.workflowId
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const [pausing, setPausing] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const stageRetry = useFleetStageRetry(run)
  const progress = conversationFleetProgress(run.jobs, run.verified)
  const actions = fleetRunPersonActions(run.jobs)
  const needsAction = run.admission !== 'pending' && progress.phase === 'needs-you'
  const reviewOnly = needsAction && actions.decisions.length === 0
  const needsDecision = needsAction && actions.decisions.length > 0
  const retryable = canRetryFleetRun(run)
  const quickAction = needsDecision
    ? translate('conversationFleet.openDecisions', 'Open decisions for {{title}}', {
        title: run.title
      })
    : reviewOnly
      ? translate('conversationFleet.reviewRun', 'View review for {{title}}', { title: run.title })
      : translate('conversationFleet.retryRun', 'Try {{title}} again', { title: run.title })
  const machine = progress.machines.join(', ') || run.machine
  // A row whose conversation is gone still opens its summary.
  const sourceOpenable = source !== null && !source.unavailable
  const summary = conversationFleetSummary(run)
  const ended = ['failed', 'complete'].includes(progress.phase)
  const [now] = useState(Date.now)
  const date =
    ended && summary.lastActivitySource === 'job' && summary.lastActivityAt
      ? new Date(summary.lastActivityAt).toLocaleDateString(getIntlLocale(), {
          month: 'short',
          day: 'numeric',
          ...(new Date(summary.lastActivityAt).getFullYear() === new Date(now).getFullYear()
            ? {}
            : { year: 'numeric' })
        })
      : null
  const caption = [fleetRunLabel(run), machine, date].filter(Boolean).join(' · ')
  const pauseSource = async (): Promise<void> => {
    if (!source || pausing) {
      return
    }
    setPausing(true)
    try {
      const result = await pauseSidebarSession(source)
      if (result.state === 'paused') {
        toast.success(result.message)
      } else if (result.state === 'already-idle') {
        toast.info(result.message)
      } else {
        toast.error(result.message)
      }
    } finally {
      setPausing(false)
    }
  }
  const body = (
    <>
      <ConversationStateIcon
        size={compact ? 'sm' : 'md'}
        className={progress.phase === 'failed' && !retryable ? 'text-muted-foreground' : undefined}
        label={reviewOnly ? translate('conversationFleet.reviewReady', 'Review ready') : undefined}
        state={
          run.admission === 'pending'
            ? 'unverifiable'
            : progress.phase === 'complete'
              ? 'done'
              : progress.phase === 'waiting'
                ? 'awaiting'
                : progress.phase === 'cancelled'
                  ? 'interrupted'
                  : progress.phase
        }
      />
      <span className="min-w-0 flex-1">
        <ConversationRowTitle
          title={run.title}
          trailing={
            hostLabel && (compact || !technical) ? <SessionRowHostLabel label={hostLabel} /> : null
          }
        />
        {!compact ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {caption}
          </span>
        ) : null}
        {!compact && technical && source ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {sessionTechnicalDetail(source, labels, runtimeEnvironments)}
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    <div
      role={onSelect ? 'option' : undefined}
      aria-selected={onSelect ? selected : undefined}
      className={cn(
        'group flex items-center rounded-md text-worktree-sidebar-foreground hover:bg-worktree-sidebar-accent',
        // Why: selection is the same ring a conversation row wears, so a mixed batch reads as one.
        selected && 'bg-worktree-sidebar-accent/60 ring-1 ring-inset ring-worktree-sidebar-ring'
      )}
      data-fleet-row={run.rowKey}
      data-session-key={key}
      data-selected={selected || undefined}
      data-session-density={compact ? 'compact' : 'comfortable'}
    >
      <Checkbox
        className="ml-1 shrink-0"
        checked={selected}
        aria-label={translate('sessions.selectSession', 'Select {{session}}', {
          session: run.title
        })}
        onCheckedChange={() =>
          useSessionSelection.getState().toggle(key, onSelect ? 'visible' : 'all')
        }
      />
      <Button
        variant="ghost"
        className={cn(
          'h-auto flex-1 justify-start px-2 text-left hover:bg-transparent hover:text-worktree-sidebar-accent-foreground has-[>svg]:px-2',
          ROW_NAME_FLOOR,
          compact ? 'gap-1.5 py-1 leading-tight' : 'gap-2 py-2'
        )}
        onClick={(event) => {
          // Why: a modified click picks rows, as on a conversation row; only a plain click opens.
          if (onSelect?.(key, event)) {
            return
          }
          if (sourceOpenable) {
            onOpenSource(source)
          } else {
            summaryPanel.openSummary(run, event.currentTarget)
          }
        }}
        tabIndex={focused === undefined ? undefined : focused ? 0 : -1}
        data-session-open=""
        data-fleet-open=""
        aria-label={
          sourceOpenable
            ? sessionRowOpenLabel(run.title, hostLabel)
            : translate('conversationFleet.openDetails', 'View summary for {{title}}', {
                title: run.title
              })
        }
      >
        {body}
      </Button>
      {needsAction || retryable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={quickAction}
              className={cn('shrink-0', needsAction && 'text-agent-question')}
              data-session-row-start=""
              disabled={!needsAction && stageRetry.retrying}
              onClick={(event) => {
                if (needsDecision) {
                  openWorkDecisions()
                } else if (reviewOnly) {
                  summaryPanel.openSummary(run, event.currentTarget)
                } else {
                  void stageRetry.retry()
                }
              }}
            >
              {needsDecision ? (
                <ClipboardCheck className="size-3.5" />
              ) : reviewOnly ? (
                <FileText className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{quickAction}</TooltipContent>
        </Tooltip>
      ) : null}
      <span className={ROW_HOVER_YIELD} data-session-row-yield="">
        <PersonalHideButton
          hidden={hidden}
          name={run.title}
          onClick={() => hideSessionsByPerson([key], !hidden)}
        />
        <ConversationArchiveButton
          archivedByHand={archivedByHand}
          name={run.title}
          onClick={() => archiveSessionsByPerson([key], !archivedByHand)}
        />
      </span>
      <span className={ROW_HOVER_REVEAL}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTrigger}
              variant="ghost"
              size="icon-xs"
              aria-label={translate('nextStep.moreOptions', 'More options')}
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (detailsOpen) {
                event.preventDefault()
              }
            }}
          >
            <DropdownMenuItem
              data-fleet-workflow={run.workflowId}
              onSelect={() => summaryPanel.openSummary(run, menuTrigger.current)}
            >
              <FileText />
              {translate('conversationFleet.details', 'View summary')}
            </DropdownMenuItem>
            {/* Why: a pause needs a reachable source; cancel and retry act on the fleet workflow itself. */}
            {source && !source.unavailable ? (
              <DropdownMenuItem disabled={pausing} onSelect={() => void pauseSource()}>
                <PauseCircle />
                {translate('conversationFleet.pauseSource', 'Pause source chat')}
              </DropdownMenuItem>
            ) : null}
            {canCancelFleetRun(run) ? (
              <DropdownMenuItem onSelect={() => setCancelOpen(true)}>
                <XCircle />
                {translate('conversationFleet.cancelMenu', 'Cancel fleet work…')}
              </DropdownMenuItem>
            ) : null}
            {canRetryFleetRun(run) ? (
              <DropdownMenuItem
                disabled={stageRetry.retrying}
                onSelect={() => void stageRetry.retry()}
              >
                <RotateCcw />
                {translate('conversationFleet.retryStopped', 'Try again')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {source ? <UpNextControls subject={{ kind: 'session', session: source }} /> : null}
      </span>
      <FleetDispatchCancelDialog run={run} open={cancelOpen} onOpenChange={setCancelOpen} />
    </div>
  )
}
