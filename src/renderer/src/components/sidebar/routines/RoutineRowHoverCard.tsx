import { AutomationContextSummary } from '@/components/automations/AutomationContextSummary'
import { useEffect, useState } from 'react'
import type { Automation, AutomationRun } from '../../../../../shared/automations-types'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { translate } from '@/i18n/i18n'
import {
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import {
  formatAutomationLastRunCell,
  getLocalAutomationLastRunSnapshot,
  indexLatestAutomationRuns
} from '@/components/automations/automation-list-last-run'
import {
  SESSION_ROW_HOVER_CARD_DELAY_MS,
  useSessionRowHoverCardOpen
} from '../session-folders/SessionRowHoverCard'
import { RoutineStateIcon } from './RoutineStateIcon'
import {
  routineNextRunDetail,
  routineRowCaption,
  routineRowState,
  routineRowStateLabel
} from './routine-row-details'
import { describeRoutineWindowSchedule } from './routine-window-label'

type Props = {
  automation: Automation
  /** The row sits under Archived. */
  archived: boolean
  target: AutomationHostTarget
  children: React.ReactNode
  /** True while a popover or menu of this row is open; the card stays shut until it closes. */
  isBusy?: () => boolean
}

/**
 * The details a one-line routine row keeps off the list: the schedule sentence, its window, the
 * next and last run, and why it is paused. Same pause, focus path and drag/menu suppression as a
 * conversation row's card.
 */
export function RoutineRowHoverCard({
  automation,
  archived,
  target,
  isBusy,
  children
}: Props): React.JSX.Element {
  const { open, onOpenChange } = useSessionRowHoverCardOpen(isBusy)
  return (
    <HoverCard
      open={open}
      onOpenChange={onOpenChange}
      openDelay={SESSION_ROW_HOVER_CARD_DELAY_MS}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* Why: the run history is asked for only once the card opens, so a long list pays nothing. */}
      {open ? (
        <HoverCardContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-72 max-h-[28rem] overflow-y-auto p-3 text-xs scrollbar-sleek"
        >
          <RoutineRowHoverCardBody automation={automation} archived={archived} target={target} />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  )
}

/** The newest retained run of one routine, read from its host; undefined until it answers or when it cannot. */
function useLatestRoutineRun(
  target: AutomationHostTarget,
  automationId: string
): AutomationRun | undefined {
  const [run, setRun] = useState<AutomationRun | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const runs = await listAutomationRunsForTarget(target, automationId)
        if (!cancelled) {
          setRun(indexLatestAutomationRuns(runs).get(automationId))
        }
      } catch {
        // Why: the card still reads with the routine's own lastRunAt; a refused read is not news.
      }
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [target, automationId])
  return run
}

function DetailRow({
  label,
  value,
  title,
  kind
}: {
  label: string
  value: string
  title?: string
  kind: 'window' | 'next-run' | 'last-run'
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 gap-2" data-routine-hover-detail={kind}>
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-foreground" title={title}>
        {value}
      </dd>
    </div>
  )
}

export function RoutineRowHoverCardBody({
  automation,
  archived,
  target
}: Omit<Props, 'children' | 'isBusy'>): React.JSX.Element {
  // Why: the card mounts fresh each time it opens, so one clock reading per opening is exact enough.
  const [now] = useState(() => Date.now())
  const state = routineRowState(automation, now)
  const latestRun = useLatestRoutineRun(target, automation.id)
  const nextRun = routineNextRunDetail(automation, now)
  const lastRun = formatAutomationLastRunCell(
    getLocalAutomationLastRunSnapshot(automation, latestRun),
    now
  )
  const windowLabel = describeRoutineWindowSchedule(automation.rrule)
  return (
    <div className="space-y-2" data-routine-hover-card="">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <RoutineStateIcon state={state} size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug text-foreground break-words">
            {automation.name}
          </div>
          <div className="text-muted-foreground" data-routine-hover-caption="">
            {routineRowCaption(automation, now).join(' · ')}
          </div>
        </div>
      </div>
      <AutomationContextSummary definition={automation} />
      <dl className="space-y-1">
        {windowLabel ? (
          <DetailRow
            label={translate('routines.window', 'Window')}
            value={windowLabel}
            kind="window"
          />
        ) : null}
        {nextRun ? (
          <DetailRow
            label={translate('routines.nextRunLabel', 'Next run')}
            value={nextRun.text}
            title={nextRun.title}
            kind="next-run"
          />
        ) : null}
        <DetailRow
          label={translate('routines.lastRunLabel', 'Last run')}
          value={lastRun.text}
          title={lastRun.title}
          kind="last-run"
        />
      </dl>
      {state === 'paused' ? (
        <div className="text-muted-foreground" data-routine-hover-paused="">
          {archived
            ? translate('routines.archivedAndPaused', 'Archived and paused')
            : routineRowStateLabel('paused')}
        </div>
      ) : archived ? (
        <div className="text-muted-foreground" data-routine-hover-archived="">
          {translate('conversations.archivedByYou', 'Archived')}
        </div>
      ) : null}
    </div>
  )
}
