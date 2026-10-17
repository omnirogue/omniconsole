import { BackofficeTaskBlock } from './backoffice-task-block'
import { useState } from 'react'
import { TaskDetailsEditor } from '@/components/tasks/TaskDetailsEditor'
import { TaskPlanSummary } from '@/components/tasks/TaskPlanSummary'
import { BackofficeTaskActivity } from './backoffice-task-activity'
import { BackofficeTaskProgress } from './backoffice-task-progress'
import {
  BackofficeTaskConversations,
  BackofficeTaskFiles,
  BackofficeTaskSessions
} from './backoffice-task-records'
import { ExternalLink } from 'lucide-react'
import { HandoffDetailView, type HandoffChange } from '@/components/handoffs/HandoffDetailView'
import { TaskSessionsSection } from '@/components/tasks/TaskSessionsSection'
import { TaskDependenciesSection } from '@/components/tasks/TaskDependenciesSection'
import { translate } from '@/i18n/i18n'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { taskCompanySlugs } from '../../../../../shared/proposed-task'
import {
  BackofficeTodoItemActions,
  type BackofficeTodoItemActionsProps
} from './backoffice-todo-item-actions'
import { HumanJobDecisionForm } from './backoffice-work-decision-form'
import { describeNextActor } from './backoffice-work-labels'
import { workRowKindLabel } from './backoffice-work-kind-label'
import { BackofficeWorkMessageDetail } from './backoffice-work-message-detail'
import { BackofficeWorkNextAction } from './backoffice-work-next-action'
import { BackofficeWorkRunSection } from './backoffice-work-run-section'
import { invalidateBackofficeWork } from './backoffice-work-store'
import { workColumn, workKanbanLabel } from './work-kanban-presentation'
import { taskStanding } from '../../../../../shared/task-state'

const EMPTY_ROWS: readonly WorkRow[] = []

type DetailProps = {
  row: WorkRow | null
  scope: string
  baseUrl: string | null
  names: ReadonlyMap<string, string>
  itemActions?: Omit<BackofficeTodoItemActionsProps, 'item'>
  initiallyEdit?: boolean
  onOpenTask: (taskId: string) => void
  /** A card read by id failed to load. */
  cardError?: string | null
  /** This person's handoff rows on a card shown read-only. */
  relatedRows?: readonly WorkRow[]
  onSelectRow?: (rowKey: string) => void
  /** Keep this row selected while a change it caused moves it out of the current tab. */
  onKeepRow: (rowKey: string) => void
  /** Only a request the person chose is marked read on open; the one shown by default is not. */
  markRead: boolean
  /** The signed-in employee; the handoff's recipient may start it with their AI. */
  viewer?: string | null
}

/* The card itself, for a reader who does not own it: what it is, who has it,
 * what counts as done, and the handoffs this person holds on it. */
function CardSections({
  row,
  names,
  error,
  relatedRows,
  onSelectRow
}: {
  row: WorkRow
  names: ReadonlyMap<string, string>
  error: string | null
  relatedRows: readonly WorkRow[]
  onSelectRow?: (rowKey: string) => void
}) {
  const card = row.card
  if (error) {
    return (
      <p className="text-sm text-destructive" data-card-error>
        {translate('backofficeWork.cardLoadFailed', 'Could not read this card: {{error}}', {
          error
        })}
      </p>
    )
  }
  if (!card) {
    return (
      <p className="text-sm text-muted-foreground" data-card-loading>
        {translate('backofficeWork.cardLoading', 'Reading the card…')}
      </p>
    )
  }
  const person = (id: string | null | undefined) => (id ? (names.get(id) ?? id) : null)
  const facts = [
    [
      translate('backofficeWork.cardStatus', 'Status'),
      card.status === 'cancelled'
        ? translate('backofficeWork.cancelled', 'Cancelled')
        : workKanbanLabel(
            taskStanding({
              status: card.status,
              kanbanStatus: card.kanban_status,
              verifiedAt: card.verified_at,
              verificationFailedAt: card.verification_failed_at
            }).state
          )
    ],
    [translate('backofficeWork.cardLane', 'Lane'), workKanbanLabel(workColumn(card))],
    [translate('backofficeWork.cardOwner', 'Owner'), person(card.owner_employee_id)],
    [translate('backofficeWork.cardRequester', 'Requested by'), person(card.requester_employee_id)],
    [
      taskCompanySlugs(card.company_slug, card.tags).length > 1
        ? translate('backofficeWork.cardCompanies', 'Companies')
        : translate('backofficeWork.cardCompany', 'Company'),
      taskCompanySlugs(card.company_slug, card.tags).join(' · ') || null
    ],
    [translate('backofficeWork.cardPriority', 'Priority'), card.priority ?? null],
    [translate('backofficeWork.cardDue', 'Due'), card.due_date ?? null],
    [translate('backofficeWork.cardUpdated', 'Updated'), card.updated_at ?? null]
  ].filter((fact): fact is [string, string] => Boolean(fact[1]))
  return (
    <div className="space-y-3" data-card-sections={card.id}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <TextBlock
        label={translate('backofficeWork.cardDescription', 'Description')}
        value={card.description ?? null}
      />
      <TaskPlanSummary
        plan={card.task_plan}
        sequentialSteps={card.sequential_steps}
        names={names}
      />
      <TextBlock
        label={translate('backofficeWork.cardAcceptance', 'What counts as done')}
        value={card.acceptance_criteria ?? null}
      />
      <TextBlock
        label={translate('backofficeWork.cardNextAction', 'Next action')}
        value={card.next_action ?? null}
      />
      <TextBlock
        label={translate('backofficeWork.cardBlocked', 'Blocked on')}
        value={card.blocked_reason ?? null}
      />
      <TextBlock
        label={translate('backofficeWork.cardResult', 'Result')}
        value={card.result_ref ?? null}
      />
      {card.tags && card.tags.length > 0 ? (
        <p className="text-xs text-muted-foreground">{card.tags.join(' · ')}</p>
      ) : null}
      {relatedRows.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate('backofficeWork.cardHandoffs', 'Your handoffs on this card')}
          </div>
          <ul className="space-y-1">
            {relatedRows.map((related) => (
              <li key={related.key}>
                <button
                  type="button"
                  className="text-left text-sm underline-offset-2 hover:underline"
                  onClick={() => onSelectRow?.(related.key)}
                >
                  {related.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {workRowKindLabel(related)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function TextBlock({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null
  }
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{value}</p>
    </div>
  )
}

/** The selected request: why it is here, who moves next, its files and the existing actions. */
export function BackofficeWorkDetail({
  row,
  scope,
  baseUrl,
  names,
  itemActions,
  initiallyEdit = false,
  onOpenTask,
  onKeepRow,
  markRead,
  viewer = null,
  cardError = null,
  relatedRows = EMPTY_ROWS,
  onSelectRow
}: DetailProps): React.JSX.Element {
  const [filesRevision, setFilesRevision] = useState(0)
  if (!row) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {translate(
          'backofficeWork.selectRow',
          'Select a request to see its files, history and actions.'
        )}
      </p>
    )
  }
  const changed = (change: HandoffChange): void => {
    if (change === 'read') {
      // Why: opening a request with nothing unread changes no list; one that had replies stays
      // open as it leaves Needs You, so the next row is not opened and marked read in turn.
      if (row.repliesWaiting === 0) {
        return
      }
      onKeepRow(row.key)
    }
    invalidateBackofficeWork()
  }
  const consoleLink =
    row.todo?.href && baseUrl
      ? `${baseUrl}${row.todo.href.startsWith('/') ? '' : '/'}${row.todo.href}`
      : row.card !== undefined && row.taskId && baseUrl
        ? `${baseUrl}/board/${row.taskId}`
        : null
  // Why: a decided stage leaves Needs You; the row stays open so the next one is not opened in turn.
  const decided = (): void => {
    onKeepRow(row.key)
    invalidateBackofficeWork()
  }
  return (
    <div className="space-y-4 p-4" data-work-detail={row.key}>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{row.title}</h3>
          <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
            {workRowKindLabel(row)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{describeNextActor(row, names)}</p>
        {row.taskId ? (
          <p className="font-mono text-[11px] text-muted-foreground">{row.taskId}</p>
        ) : null}
      </header>
      {row.taskId && (
        <TaskDetailsEditor
          key={`details:${scope}:${row.taskId}`}
          taskId={row.taskId}
          initiallyOpen={initiallyEdit}
          onSaved={() => {
            setFilesRevision((value) => value + 1)
            invalidateBackofficeWork()
            if (row.card !== undefined && row.taskId) {
              onOpenTask(row.taskId)
            }
          }}
        />
      )}
      {row.card !== undefined ? (
        <CardSections
          row={row}
          names={names}
          error={cardError}
          relatedRows={relatedRows}
          onSelectRow={onSelectRow}
        />
      ) : null}
      <TextBlock label={translate('backofficeWork.why', 'Why it is here')} value={row.why} />
      <TextBlock label={translate('backofficeWork.what', 'What happens next')} value={row.what} />
      {row.todo && row.actionLabel ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'backofficeWork.preparedAction',
            'The Console prepared "{{action}}"; act through the controls below or in the Console.',
            { action: row.actionLabel }
          )}
        </p>
      ) : null}
      {consoleLink ? (
        <a
          className="inline-flex items-center gap-1.5 text-xs font-medium underline"
          href={consoleLink}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="size-3.5" />
          {translate('backofficeWork.openInConsole', 'Open in the Console')}
        </a>
      ) : null}
      {row.todo && itemActions ? (
        <BackofficeTodoItemActions item={row.todo} {...itemActions} />
      ) : null}
      {row.job ? (
        <HumanJobDecisionForm key={row.job.id} job={row.job} scope={scope} onDecided={decided} />
      ) : null}
      {row.todo ? (
        <BackofficeWorkNextAction
          key={`next-action:${scope}:${row.todo.task_id}`}
          taskId={row.todo.task_id}
        />
      ) : null}
      {row.taskId ? <TaskSessionsSection key={row.taskId} taskId={row.taskId} /> : null}
      {row.taskId ? (
        <TaskDependenciesSection
          key={`deps:${row.taskId}`}
          taskId={row.taskId}
          taskStatus={row.todo?.status ?? null}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {row.todo ? (
        <BackofficeWorkRunSection
          key={`workflows:${scope}:${row.todo.task_id}`}
          scope={scope}
          taskId={row.todo.task_id}
        />
      ) : null}
      {row.message ? (
        <BackofficeWorkMessageDetail
          key={`${scope}:${row.message.id}`}
          viewer={viewer}
          row={row}
          message={row.message}
          names={names}
          baseUrl={baseUrl}
          onOpenTask={onOpenTask}
          onChanged={decided}
        />
      ) : null}
      {row.followUp ? (
        <p className="rounded-md bg-muted p-3 text-xs">
          {translate(
            'backofficeWork.followUpNote',
            'Saved on this computer. Nothing is sent until the run finishes with its final files.'
          )}
        </p>
      ) : null}
      {row.taskId && (
        <div key={`${scope}:${row.taskId}`} className="space-y-4">
          <BackofficeTaskBlock taskId={row.taskId} />
          <BackofficeTaskActivity taskId={row.taskId} names={names} />
          <details>
            <summary className="text-sm font-semibold">
              {translate('unifiedWork.e9bf877b9984', 'Files and evidence')}
            </summary>
            <BackofficeTaskFiles taskId={row.taskId} baseUrl={baseUrl} refreshKey={filesRevision} />
          </details>
          <details>
            <summary className="text-sm font-semibold">
              {translate('unifiedWork.d4773c5e5b24', 'Workflow, attempts and waits')}
            </summary>
            <BackofficeTaskProgress taskId={row.taskId} baseUrl={baseUrl} onOpenTask={onOpenTask} />
          </details>
          <BackofficeTaskConversations key={`conversations:${row.taskId}`} taskId={row.taskId} />
          <details>
            <summary className="text-sm font-semibold">
              {translate('unifiedWork.c1c80b037867', 'Session history')}
            </summary>
            <BackofficeTaskSessions taskId={row.taskId} baseUrl={baseUrl} />
          </details>
        </div>
      )}
      {row.thread ? (
        <HandoffDetailView
          key={row.thread.id}
          scope={scope}
          threadId={row.thread.id}
          markRead={markRead}
          viewer={viewer ?? null}
          onOpenTask={() => {
            const taskId = row.thread?.board_task_id
            if (taskId) {
              onOpenTask(taskId)
            }
          }}
          onChanged={changed}
        />
      ) : null}
    </div>
  )
}
