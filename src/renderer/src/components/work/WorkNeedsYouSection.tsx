import React, { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { RunAttentionAction } from '@/components/attention/RunAttentionAction'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { UpNextControls } from '@/components/next-action/UpNextControls'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { useNeedsYouCounts } from '@/components/task-page/backoffice/backoffice-needs-you-counts'
import { describeWorkGap } from '@/components/task-page/backoffice/backoffice-work-labels'
import { formatDue } from '@/components/task-page/backoffice/backoffice-work-list'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { WorkRow } from '../../../../shared/backoffice-work-views'
import {
  usePaneHasPendingQuestion,
  useSessionQuestionsInline
} from '@/components/needs-you/use-session-question-rows'
import { NeedsYouQuestionRow } from '@/components/needs-you/NeedsYouQuestionRow'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  HandoffQuestionAnswer,
  isAnswerableHandoffQuestion
} from '@/components/task-page/backoffice/HandoffQuestionAnswer'
import { WorkDecisionsBox } from './WorkDecisionsBox'
import { WorkReviewWaitsSection } from './WorkReviewWaitsSection'
import { WorkSectionTitle } from './WorkSectionTitle'

const ROW_LIMIT = 8

function openSession(session: SidebarSession): void {
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
}

/** A run's request: what is needed, why only the person can give it, and the way to give it. */
function RunRequestRow({
  pane,
  sessions
}: {
  pane: AttentionPane
  sessions: readonly SidebarSession[]
}): React.JSX.Element | null {
  const run = pane.run
  if (!run) {
    return null
  }
  const owner = sessions.find((session) => session.rowKey === run.sourceRowKey)
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      data-work-needs-you-request={run.chainId}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-agent-question-text" title={run.headline}>
          {run.headline}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={run.why}>
          {[run.why, owner?.label ?? pane.title].filter(Boolean).join(' · ')}
        </div>
      </div>
      <RunAttentionAction pane={pane} run={run} sessions={sessions} />
    </li>
  )
}

/** A pane waiting on the person: open it, or decide what happens next without opening it. */
function WaitingPaneRow({
  pane,
  session
}: {
  pane: AttentionPane
  session: SidebarSession | null
}): React.JSX.Element {
  const title = pane.title || session?.label || pane.worktreeName
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      data-work-needs-you-pane={pane.paneKey}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {pane.cause === 'blocked'
            ? translate('work.paneBlocked', 'Waiting for your answer')
            : translate('work.paneWaiting', 'Finished and waiting for you')}
          {' · '}
          {pane.worktreeName || pane.repoName}
        </div>
      </div>
      {session ? <UpNextControls subject={{ kind: 'session', session }} /> : null}
      {session ? (
        <Button size="xs" variant="outline" onClick={() => openSession(session)}>
          {translate('work.open', 'Open')}
          <ChevronRight className="size-3" aria-hidden />
        </Button>
      ) : (
        // Why: a pane the sessions tree cannot address is still reachable through Focus.
        <Button
          size="xs"
          variant="outline"
          onClick={() => useAppStore.getState().openAttentionPage()}
        >
          {translate('work.openInFocus', 'Open in Focus')}
          <ChevronRight className="size-3" aria-hidden />
        </Button>
      )}
    </li>
  )
}

/** Local questions use the durable Decisions queue; paired questions stay with their live owner. */
function PaneRow({
  pane,
  session,
  inline
}: {
  pane: AttentionPane
  session: SidebarSession | null
  inline: boolean
}): React.JSX.Element | null {
  const asking = usePaneHasPendingQuestion(pane.paneKey)
  const owner = parseExecutionHostId(session?.hostId)
  const ownerReachable = useAppStore((state) =>
    owner?.kind === 'runtime'
      ? Boolean(state.runtimeStatusByEnvironmentId.get(owner.environmentId)?.status)
      : false
  )
  if (inline && asking) {
    // Why: the local Decisions store never receives another runtime's native question hooks.
    return owner?.kind === 'runtime' ? (
      <NeedsYouQuestionRow
        paneKey={pane.paneKey}
        title={pane.title || session?.label || pane.worktreeName}
        answerable={ownerReachable && !pane.activityUnverifiable}
        onOpen={session ? () => openSession(session) : undefined}
      />
    ) : null
  }
  return <WaitingPaneRow pane={pane} session={session} />
}

/** A card or thread from the console that names the person as the next actor. */
function WorkQueueRow({ row, onOpen }: { row: WorkRow; onOpen: () => void }): React.JSX.Element {
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      data-work-needs-you-row={row.key}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {row.why ?? row.what ?? row.actionLabel ?? row.kind}
          {row.dueAt
            ? ` · ${translate('work.due', 'due {{when}}', { when: formatDue(row.dueAt) })}`
            : ''}
        </div>
      </div>
      {row.todo ? <UpNextControls subject={{ kind: 'card', item: row.todo }} /> : null}
      <Button size="xs" variant="outline" onClick={onOpen}>
        {translate('work.open', 'Open')}
        <ChevronRight className="size-3" aria-hidden />
      </Button>
      {row.todo && isAnswerableHandoffQuestion(row.todo) ? (
        <div className="w-full">
          <HandoffQuestionAnswer key={row.todo.decision_id} item={row.todo} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * What needs the person right now: sessions waiting on them (from the panes
 * themselves) and the console cards, threads, decisions and messages that name them
 * next. The total is the one formula the Work badge and Attention show too.
 */
export function WorkNeedsYouSection(): React.JSX.Element {
  const sessions = useSidebarSessions()
  const scope = useHandoffScope()
  const { panes, views, counts, loading } = useNeedsYouCounts(scope, true)
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const inlineQuestions = useSessionQuestionsInline()
  const sessionByPane = useMemo(
    () => new Map(sessions.filter((row) => row.paneKey).map((row) => [row.paneKey as string, row])),
    [sessions]
  )
  const rows = views.needsYou
  // Why: idle and loading reads project as gaps too; the banner waits for the first answer.
  const feedUnavailable =
    !loading &&
    views.gaps.includes('todo-unavailable') &&
    views.gaps.includes('received-unavailable')
  const total = counts.total
  const openList = (): void => {
    // Why: the list opens on the lens whose rows this section advertised, not a remembered one.
    useBackofficeWorkFocus.getState().focus({ scope, lens: 'needs-you' })
    openTaskPage({ taskSource: 'backoffice' })
  }
  const openRow = (row: WorkRow): void => {
    // Why: the Work list answers a focus request by row key, whatever feed the row came from.
    useBackofficeWorkFocus.getState().focus({ scope, lens: 'needs-you', rowKey: row.key })
    openTaskPage({ taskSource: 'backoffice' })
  }
  return (
    <>
      {inlineQuestions ? <WorkDecisionsBox /> : null}
      <WorkReviewWaitsSection />
      <section aria-label={translate('work.needsYou', 'Needs you')} data-work-needs-you={total}>
        <WorkSectionTitle
          title={translate('work.needsYou', 'Needs you')}
          sub={
            loading && total === 0
              ? translate('work.loading', 'Loading…')
              : translate('work.needsYouCount', '{{count}} waiting on you', { count: total })
          }
          action={
            <Button size="xs" variant="ghost" onClick={openList}>
              {translate('work.allTasks', 'All tasks')}
            </Button>
          }
        />
        {feedUnavailable ? (
          <p
            role="status"
            className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
          >
            {translate(
              'work.feedUnavailable',
              'The console work feed is unavailable — sign in to OmniOS or check the connection. Sessions waiting on you still show here.'
            )}
          </p>
        ) : null}
        {total === 0 && !loading && !feedUnavailable ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
            {translate('work.nothingNeedsYou', 'Nothing needs you right now.')}
          </p>
        ) : null}
        <ul className="space-y-1.5">
          {panes.map((pane) =>
            pane.run ? (
              <RunRequestRow key={pane.paneKey} pane={pane} sessions={sessions} />
            ) : (
              <PaneRow
                key={pane.paneKey}
                pane={pane}
                session={sessionByPane.get(pane.paneKey) ?? null}
                inline={inlineQuestions}
              />
            )
          )}
          {rows.slice(0, ROW_LIMIT).map((row) => (
            <WorkQueueRow key={row.key} row={row} onOpen={() => openRow(row)} />
          ))}
        </ul>
        {rows.length > ROW_LIMIT ? (
          <Button size="xs" variant="ghost" className="mt-1" onClick={openList}>
            {translate('work.moreInTasks', '{{count}} more in Tasks', {
              count: rows.length - ROW_LIMIT
            })}
          </Button>
        ) : null}
        {views.gaps.length > 0 && !feedUnavailable && !loading ? (
          <p
            className="mt-1 text-[11px] text-muted-foreground"
            title={views.gaps.map(describeWorkGap).join('\n')}
          >
            {translate('work.partialFeed', 'Partial: {{detail}}', {
              detail: views.gaps.map(describeWorkGap).join(' · ')
            })}
          </p>
        ) : null}
      </section>
    </>
  )
}
