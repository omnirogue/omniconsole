import { DiscussionWorkspace } from '@/components/inbox/DiscussionWorkspace'
import { NewTaskButton } from '@/components/tasks/NewTaskButton'
import { BackofficeWorkBoardWorkspace } from './backoffice-work-board-workspace'
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useSessionFollowUpRows } from '@/lib/session-follow-up-rows'
import { translate } from '@/i18n/i18n'
import { BackofficeCompletionEvidenceDialog } from './backoffice-completion-evidence-dialog'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import { cardRow, cardRowKey, type WorkRow } from '../../../../../shared/backoffice-work-views'
import type { ConsoleTaskRecord } from '../../../../../shared/console-workflow-types'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import type { BackofficeTodoState } from '../hooks/use-task-page-backoffice'
import { BackofficeWorkDetail } from './backoffice-work-detail'
import { BackofficeWorkFilterRow } from './backoffice-work-filter-row'
import { BackofficeWorkLensRow } from './backoffice-work-lens-row'
import { BackofficeNewMessage } from './backoffice-new-message'
import {
  EMPTY_WORK_FILTER,
  describeWorkGap,
  filterWorkRows,
  gapsForLens,
  isWorkFilterNarrowing,
  narrowingWorkFilter,
  workEmptyText,
  workFilterChoices
} from './backoffice-work-labels'
import { BackofficeActionList } from './BackofficeActionList'
import { BackofficeArchivedHandoffs } from './BackofficeArchivedHandoffs'
import { valueOf } from './backoffice-work-reads'
import {
  allLensSelection,
  resolveWorkFocus,
  useBackofficeWorkFocus,
  useBackofficeWorkSelection,
  type WorkSelection
} from './backoffice-work-selection'
import { DismissDecisionsButton } from './backoffice-dismiss-decisions'
import { loadMoreBackofficeTodo, useBackofficeWorkViews } from './backoffice-work-store'
import { useWaitingKeys } from '@/store/wait-later-store'
import { withoutWaitingThreads } from './backoffice-work-waiting'

export type BackofficeTodoListHostProps = {
  state: BackofficeTodoState
  onRefresh: () => void
  onUseItem: (item: BackofficeTodoItem) => void
  /** Completion now runs through ✓ on the row; kept so the page's hook wiring stays untouched. */
  onCompleteItem?: (item: BackofficeTodoItem) => void
  onArchiveItem: (item: BackofficeTodoItem) => void
  completionPending?: string | null
  /** The card whose archive is in flight, if any — that row's button waits. */
  archivePending: string | null
  onOpenOffice: () => void
  /** Set while the hub's done-gate holds a card for a named result ref. */
  evidenceRequest?: BackofficeTodoItem | null
  onSubmitEvidence?: (item: BackofficeTodoItem, resultRef: string) => void
  onDismissEvidence?: () => void
}

/**
 * Tasks → Backoffice: Needs You / Waiting For / All over the Console's own obligations,
 * in a list and detail layout. Server-scoped: every row comes from an authorised read,
 * and a read the server does not provide is named rather than shown as an empty list.
 */
export function BackofficeTodoListHost({
  state,
  onRefresh,
  onUseItem,
  onArchiveItem,
  archivePending,
  completionPending = null,
  onOpenOffice,
  evidenceRequest = null,
  onSubmitEvidence,
  onDismissEvidence
}: BackofficeTodoListHostProps): React.JSX.Element {
  const [board, setBoard] = useState(false)
  const [discussions, setDiscussions] = useState(false)
  const scope = useHandoffScope()
  // Why: saved next steps on running sessions are Waiting For rows alongside sent requests.
  const followUps = useSessionFollowUpRows()
  const { selection, update } = useBackofficeWorkSelection(scope)
  // Why: finished requests are read only for a lens that shows them; Needs You never pays for them.
  const showsFinished =
    selection.lens === 'all' &&
    (selection.filter.status === 'all' || selection.filter.status === 'finished')
  const projected = useBackofficeWorkViews(scope, true, followUps, { history: showsFinished })
  // Why: a thread the person asked to wait on leaves Needs You until its time; All still lists it.
  const waiting = useWaitingKeys()
  const views = useMemo(
    () => withoutWaitingThreads(projected.views, waiting),
    [projected.views, waiting]
  )
  const { names, loading } = projected
  const todoLoad = projected.reads.todo
  const todoFeed =
    todoLoad.phase === 'ready'
      ? todoLoad.value
      : todoLoad.phase === 'loading'
        ? todoLoad.previous
        : null
  const viewer =
    todoFeed?.employeeId ??
    valueOf(projected.reads.receivedOpen)?.assignee ??
    valueOf(projected.reads.sent)?.assignee ??
    null
  const loadMore = todoFeed?.nextCursor
    ? {
        pending: todoLoad.phase === 'loading',
        onLoadMore: () => void loadMoreBackofficeTodo(scope)
      }
    : undefined
  const filter = selection.filter
  // Why: a remembered selection opens the same row again, but only a row the person chose in
  // this session (a click, a deep link) is marked read; storage alone never reads a request.
  const [chosen, setChosen] = useState<{ scope: string; key: string } | null>(null)
  const chosenKey = chosen?.scope === scope ? chosen.key : null
  const focus = useBackofficeWorkFocus((store) => store.request)
  const missing = useBackofficeWorkFocus((store) => store.missing)

  useEffect(() => {
    if (!focus) {
      return
    }
    // Why: Attention and Inbox open the same identified work here; apply their request once.
    const outcome = resolveWorkFocus(focus, scope, views.all, loading, filter)
    switch (outcome.kind) {
      case 'wait':
        return
      case 'drop':
        useBackofficeWorkFocus.getState().settle(null)
        return
      case 'select':
        update(outcome.selection)
        if (outcome.selection.rowKey) {
          setChosen({ scope, key: outcome.selection.rowKey })
        }
        useBackofficeWorkFocus.getState().settle(null)
        return
      case 'missing':
        update(outcome.selection)
        useBackofficeWorkFocus.getState().settle({ scope, id: outcome.id })
    }
  }, [filter, focus, loading, scope, update, views.all])

  // Why: the person's own choice replaces a "not in your lists" note from an earlier request.
  const choose = (next: Partial<WorkSelection>): void => {
    if (missing) {
      useBackofficeWorkFocus.getState().settle(null)
    }
    update(next)
  }

  // Why: a card that is not one of this person's rows (a handoff on somebody
  // else's card) is read by id and shown here read-only, not on the workflow
  // Jobs view, which is for running jobs.
  const [external, setExternal] = useState<{
    taskId: string
    scope: string
    card: ConsoleTaskRecord | null
    error: string | null
  } | null>(null)
  const openTask = (taskId: string): void => {
    const row = views.all.find(
      (candidate) => candidate.taskId === taskId && candidate.source === 'task'
    )
    if (row) {
      setChosen({ scope, key: row.key })
      choose(allLensSelection(row, filter))
      return
    }
    setChosen({ scope, key: cardRowKey(taskId) })
    choose({ lens: 'all', rowKey: cardRowKey(taskId) })
    const request = { scope, taskId, card: null, error: null }
    setExternal(request)
    void consoleWorkflowApi()
      .getTask({ taskId })
      .then((result) => {
        const card = workflowData(result)
        setExternal((current) => (current === request ? { ...request, card } : current))
      })
      .catch((reason: unknown) =>
        setExternal((current) =>
          current === request
            ? { ...request, error: reason instanceof Error ? reason.message : String(reason) }
            : current
        )
      )
  }
  const externalRow =
    external && external.scope === scope && selection.rowKey === cardRowKey(external.taskId)
      ? cardRow(external.taskId, external.card, state.phase === 'ready' ? state.employeeId : null)
      : null
  const externalError = externalRow ? (external?.error ?? null) : null

  // Why: Needs You and Waiting For are presorted (decisions first, due dates first) with waits
  // stripped; search and source narrow those arrays, they never re-derive status from All.
  const lensRows: readonly WorkRow[] =
    selection.lens === 'needs-you'
      ? views.needsYou
      : selection.lens === 'waiting'
        ? views.waitingFor
        : views.all
  // Why: All keeps a put-away row, but never lists it as needing the person while it waits.
  const rows: WorkRow[] =
    selection.lens === 'all'
      ? filterWorkRows(lensRows, filter, names, { waiting })
      : filterWorkRows(lensRows, narrowingWorkFilter(filter), names)
  const narrowed = rows.length === 0 && lensRows.length > 0 && isWorkFilterNarrowing(filter)
  // Why: a row an action moved out of this tab stays open, so the next row is not opened (and read).
  const selected =
    rows.find((row) => row.key === selection.rowKey) ??
    views.all.find((row) => row.key === selection.rowKey) ??
    externalRow ??
    rows[0] ??
    null
  // Why: the card's own handoffs are this person's rows on it; the read-only card lists them.
  const relatedRows =
    selected?.card !== undefined
      ? views.all.filter((row) => row.taskId === selected.taskId && row.thread)
      : []
  const gaps = gapsForLens(selection.lens, views.gaps, showsFinished)
  const choices = useMemo(() => workFilterChoices(views.all), [views.all])

  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <BackofficeWorkLensRow
          lens={selection.lens}
          active={!board && !discussions}
          counts={views.counts}
          onChange={(lens) => {
            setBoard(false)
            setDiscussions(false)
            choose({ lens, rowKey: null })
          }}
          afterWaiting={
            <Button
              variant={board ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={board}
              onClick={() => {
                setDiscussions(false)
                setBoard(true)
              }}
            >
              {translate('tasks.kanban', 'Kanban')}
            </Button>
          }
        />
        <Button
          variant={discussions ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={discussions}
          onClick={() => {
            setBoard(false)
            setDiscussions(!discussions)
          }}
        >
          {translate('discussions.title', 'Discussions')}
        </Button>
        <div className="flex items-center gap-1">
          {!board && (
            <NewTaskButton
              initialFiling={{
                companySlug: selected?.todo?.company_slug,
                unitId: selected?.todo?.org_unit_id,
                projectId: selected?.todo?.project_id
              }}
              onCreated={onRefresh}
            />
          )}
          {state.phase === 'ready' && state.employeeId ? (
            <span className="mr-1 font-mono text-[11px] text-muted-foreground">
              {state.employeeId}
            </span>
          ) : null}
          <BackofficeNewMessage
            onSent={() => {
              setBoard(false)
              choose({ lens: 'waiting', rowKey: null, filter: EMPTY_WORK_FILTER })
            }}
          />
          <Button variant="ghost" size="sm" onClick={onOpenOffice}>
            {translate('auto.components.TaskPage.backofficeOffice', '3D Office')}
          </Button>
          <DismissDecisionsButton onDismissed={onRefresh} />
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            aria-label={translate('backoffice.todoList.refresh', 'Refresh')}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>
      {discussions ? (
        <DiscussionWorkspace
          scope={scope}
          key={scope}
          onOpenTask={(id) => {
            setDiscussions(false)
            openTask(id)
          }}
        />
      ) : board ? (
        <BackofficeWorkBoardWorkspace
          key={scope}
          scope={scope}
          rows={views.all}
          viewer={viewer}
          names={names}
          baseUrl={state.phase === 'ready' ? state.baseUrl : null}
          itemActions={{ onUseItem, onArchiveItem, archivePending }}
          onRefresh={onRefresh}
        />
      ) : (
        <>
          <BackofficeWorkFilterRow
            filter={filter}
            choices={choices}
            names={names}
            allControls={selection.lens === 'all'}
            onChange={(next) => choose({ filter: next })}
          />
          {gaps.map((gap) => (
            <p
              key={gap}
              className="border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground"
              data-work-gap={gap}
            >
              {describeWorkGap(gap)}
              {gap === 'todo-unavailable' && state.phase === 'error' ? ` ${state.message}` : ''}
            </p>
          ))}
          {missing?.scope === scope ? (
            <p
              className="border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground"
              data-work-focus-missing={missing.id}
            >
              {translate('backofficeWork.focusMissing', 'That work is not in your lists here.')}
            </p>
          ) : null}
          <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <div className="min-h-0 overflow-y-auto scrollbar-sleek md:border-r md:border-border/50">
              {loading && rows.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {translate('auto.components.TaskPage.backofficeLoading', 'Loading your tasks…')}
                </div>
              ) : (
                <BackofficeActionList
                  key={scope}
                  scope={scope}
                  viewer={viewer}
                  toolbar={
                    <BackofficeArchivedHandoffs
                      scope={scope}
                      viewer={viewer}
                      names={names}
                      filter={filter}
                      onOpenTask={openTask}
                    />
                  }
                  rows={rows}
                  selectedKey={selected?.key ?? null}
                  names={names}
                  emptyText={workEmptyText(selection.lens, views.gaps, narrowed)}
                  onSelect={(rowKey) => {
                    setChosen({ scope, key: rowKey })
                    choose({ rowKey })
                  }}
                  {...(loadMore ? { loadMore } : {})}
                />
              )}
            </div>
            <div className="min-h-0 overflow-y-auto scrollbar-sleek">
              <BackofficeWorkDetail
                row={selected}
                scope={scope}
                baseUrl={state.phase === 'ready' ? state.baseUrl : null}
                viewer={state.phase === 'ready' ? state.employeeId : null}
                names={names}
                itemActions={{ onUseItem, onArchiveItem, archivePending }}
                onOpenTask={openTask}
                cardError={externalError}
                relatedRows={relatedRows}
                onSelectRow={(rowKey) => {
                  const row = views.all.find((candidate) => candidate.key === rowKey)
                  if (row) {
                    setChosen({ scope, key: rowKey })
                    choose(allLensSelection(row, filter))
                  }
                }}
                onKeepRow={(rowKey) => update({ rowKey })}
                // Why: the first row is shown by default and a remembered row is shown again; either is
                // read only once the person chooses it here, so a review that moves one row out never
                // opens and reads the next, and a reply that arrived overnight is not read unseen.
                markRead={selected !== null && selected.key === chosenKey}
              />
            </div>
          </div>
        </>
      )}
      {evidenceRequest && onSubmitEvidence && onDismissEvidence && (
        <BackofficeCompletionEvidenceDialog
          item={evidenceRequest}
          pending={completionPending === evidenceRequest.task_id}
          onSubmit={(resultRef) => onSubmitEvidence(evidenceRequest, resultRef)}
          onDismiss={onDismissEvidence}
        />
      )}
    </div>
  )
}
