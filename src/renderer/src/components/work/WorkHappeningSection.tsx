import React, { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { UpNextControls } from '@/components/next-action/UpNextControls'
import { SessionChainStatus } from '@/components/next-step/SessionChainStatus'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { useSessionHostScope } from '@/components/sidebar/session-folders/use-session-host-scope'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { describeReturn } from '@/lib/wait-later'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useFinishedMarks, useWaitingKeys, useWaitingUntil } from '@/store/wait-later-store'
import { WorkSectionTitle } from './WorkSectionTitle'
import { countByState, sessionActivities, type SessionActivity } from './work-model'

import { beginCommandCenterSessionDrag } from '@/lib/command-center-session-drag'
import { clearSessionSidebarDrag } from '@/lib/session-sidebar-drag'

const ROW_LIMIT = 12
const NO_FLEET_RUNS: never[] = []

function stateLabel(row: SessionActivity, now: Date): string {
  switch (row.state) {
    case 'needs-you':
      return translate('work.stateNeedsYou', 'Needs you')
    case 'working':
      return translate('work.stateWorking', 'Working')
    case 'waiting': {
      const until = row.until ? new Date(row.until) : null
      return until && Number.isFinite(until.getTime())
        ? translate('work.stateSnoozedUntil', 'Snoozed · back {{when}}', {
            when: describeReturn(until, now)
          })
        : translate('work.stateSnoozed', 'Snoozed')
    }
    case 'finished':
      return translate('work.stateFinished', 'Finished')
    case 'idle':
      return translate('work.stateIdle', 'Idle')
  }
}

// Why: Sal's session colors — live work is green, finished work rests grey like the Sessions tree.
const STATE_TONE: Record<SessionActivity['state'], string> = {
  'needs-you': 'bg-agent-question/15 text-agent-question-text',
  working: 'bg-status-success-background text-status-success',
  waiting: 'bg-muted text-muted-foreground',
  finished: 'bg-muted text-muted-foreground',
  idle: 'bg-muted text-muted-foreground'
}

function SessionRow({ row, now }: { row: SessionActivity; now: Date }): React.JSX.Element {
  const { session } = row
  const draggable = useAppStore((state) => state.settings?.commandCenter === true)
  const chain = useSessionChainForRow(session.rowKey)
  return (
    <li
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (event) => beginCommandCenterSessionDrag(event.dataTransfer, session)
          : undefined
      }
      onDragEnd={draggable ? clearSessionSidebarDrag : undefined}
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      data-work-session={session.rowKey}
      data-work-session-state={row.state}
    >
      <span
        className={cn(
          'shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold',
          STATE_TONE[row.state]
        )}
      >
        {stateLabel(row, now)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.card?.title || session.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {session.workspaceLabel}
          {session.agent ? ` · ${session.agent}` : ''}
        </div>
      </div>
      <UpNextControls
        subject={{ kind: 'session', session }}
        status={chain ? <SessionChainStatus chain={chain} session={session} /> : null}
      />
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          void activateSidebarSession(session).then((opened) => {
            if (!opened) {
              toast.error(
                translate(
                  'work.openSessionFailed',
                  'This session could not be opened; check its workspace.'
                )
              )
            }
          })
        }}
      >
        {translate('work.open', 'Open')}
        <ChevronRight className="size-3" aria-hidden />
      </Button>
    </li>
  )
}

/**
 * What is happening: every open session and its state — working, waiting on a
 * timer, finished, idle — from the same pane snapshot the Sessions tree draws.
 */
export function WorkHappeningSection(): React.JSX.Element {
  const observedSessions = useSidebarSessions()
  const { sessions } = useSessionHostScope(observedSessions, NO_FLEET_RUNS)
  const snapshot = useAgentPaneSnapshot()
  const waiting = useWaitingKeys()
  const until = useWaitingUntil()
  const finished = useFinishedMarks()
  const openCompaniesPage = useAppStore((state) => state.openCompaniesPage)
  const setSidebarSessionSurface = useAppStore((state) => state.setSidebarSessionSurface)
  const setActiveView = useAppStore((state) => state.setActiveView)
  // Why: the same move as the Sessions primary — the tree AND the workbench.
  const openSessions = (): void => {
    setSidebarSessionSurface('sessions')
    setActiveView('terminal')
  }
  const rows = useMemo(
    () => sessionActivities(sessions, snapshot, waiting, until, finished),
    [sessions, snapshot, waiting, until, finished]
  )
  const counts = countByState(rows)
  const now = new Date()
  const summary = [
    translate('work.workingCount', '{{count}} working', { count: counts.working }),
    translate('work.waitingCount', '{{count}} waiting', { count: counts.waiting }),
    translate('work.finishedCount', '{{count}} finished', { count: counts.finished })
  ].join(' · ')
  return (
    <section
      aria-label={translate('work.happening', 'Happening now')}
      data-work-sessions={rows.length}
    >
      <WorkSectionTitle
        title={translate('work.happening', 'Happening now')}
        sub={rows.length > 0 ? summary : undefined}
        action={
          <Button size="xs" variant="ghost" onClick={openSessions}>
            {translate('work.allSessions', 'All sessions')}
          </Button>
        }
      />
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-3">
          <p className="text-sm text-muted-foreground">
            {translate('work.nothingRunning', 'Nothing is running.')}
          </p>
          <Button size="xs" variant="outline" onClick={() => openCompaniesPage()}>
            {translate('work.startFromCompanies', 'Start a session from Companies')}
          </Button>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {rows.slice(0, ROW_LIMIT).map((row) => (
            <SessionRow key={row.session.rowKey} row={row} now={now} />
          ))}
        </ul>
      )}
      {rows.length > ROW_LIMIT ? (
        <Button size="xs" variant="ghost" className="mt-1" onClick={openSessions}>
          {translate('work.moreSessions', '{{count}} more in Sessions', {
            count: rows.length - ROW_LIMIT
          })}
        </Button>
      ) : null}
    </section>
  )
}
