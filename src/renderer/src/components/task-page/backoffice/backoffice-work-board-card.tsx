import { translate } from '@/i18n/i18n'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { isProposedTask, taskCompanySlugs } from '../../../../../shared/proposed-task'
import { workKanbanBadges, workKanbanLabel, type WorkColumn } from './work-kanban-presentation'
import { WorkCardDependencyBadge } from '@/components/tasks/WorkCardDependencyBadge'
import { describeNextActor } from './backoffice-work-labels'

export function BackofficeWorkBoardCard({
  card,
  related,
  names,
  companyNames,
  domainName,
  mode,
  column,
  onOpenTask
}: {
  card: WorkCard
  related: readonly WorkRow[]
  names: ReadonlyMap<string, string>
  /** Company display names by slug; a slug with no name is shown as itself. */
  companyNames?: ReadonlyMap<string, string>
  domainName?: string
  mode: 'board' | 'list' | 'timeline'
  column: WorkColumn
  onOpenTask: (id: string) => void
}): React.JSX.Element {
  const next = related.find((row) => row.needsYou || row.waitingFor) ?? related[0]
  const badges = workKanbanBadges(
    card,
    related.some((row) => row.needsYou)
  )
  const companies = taskCompanySlugs(card.company_slug, card.tags)
  // Why: a proposed card past Ready shows in its real lane; the badge keeps the proposal
  // visible while it is still open. A finished card is an outcome, not an idea.
  const proposedElsewhere = isProposedTask(card.tags) && column !== 'proposed' && column !== 'done'
  const description = card.description?.trim()
  return (
    <button
      type="button"
      onClick={() => onOpenTask(card.id)}
      className="block w-full space-y-1 rounded-md border border-border bg-card p-3 text-left text-card-foreground hover:bg-accent"
      data-work-card={card.id}
      data-kanban-status={column}
    >
      <p className="text-sm font-medium">{card.title}</p>
      {mode !== 'board' && (
        <p className="text-xs font-medium">
          {card.status === 'cancelled'
            ? translate('workKanban.cancelled', 'Cancelled')
            : card.kanban_disposition === 'archived'
              ? translate('workKanban.archived', 'Archived')
              : workKanbanLabel(column)}
        </p>
      )}
      {(badges.length > 0 || proposedElsewhere) && (
        <div className="flex flex-wrap gap-1">
          {proposedElsewhere && (
            <span
              data-work-condition="proposed"
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {translate('workKanban.proposed', 'Proposed')}
            </span>
          )}
          {badges.map((badge) => (
            <span
              key={badge.kind}
              data-work-condition={badge.kind}
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}
      <WorkCardDependencyBadge card={card} />
      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {companies.length === 0 ? (
          <span>{translate('unifiedWork.d64dc9ae400c', 'Unfiled')}</span>
        ) : (
          companies.map((slug) => (
            <span
              key={slug}
              data-work-company={slug}
              className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {companyNames?.get(slug) ?? slug}
            </span>
          ))
        )}
        <span>
          · {domainName ?? card.org_unit_id ?? translate('unifiedWork.8a53b8c8d5a1', 'No domain')}
        </span>
      </p>
      {description && (
        <p className="line-clamp-3 text-xs" data-work-description>
          {description}
        </p>
      )}
      <p className="text-xs">
        {translate('tasks.ownerLabel', 'Owner:')}{' '}
        {names.get(card.owner_employee_id ?? '') ??
          card.owner_employee_id ??
          translate('unifiedWork.14d33bd014e6', 'Unassigned')}
      </p>
      <p className="text-xs">
        {next ? translate('tasks.actorLabel', 'Actor:') : translate('tasks.peopleLabel', 'People:')}{' '}
        {next
          ? describeNextActor(next, names)
          : card.actors?.length
            ? card.actors
                .map((actor) => {
                  const id = typeof actor === 'string' ? actor : actor.id
                  return names.get(id) ?? id
                })
                .join(', ')
            : translate('unifiedWork.84ae4e0693ce', 'Current actor not reported')}
      </p>
      <p className="line-clamp-3 text-xs">
        {translate('tasks.outcomeLabel', 'Outcome:')}{' '}
        {card.acceptance_criteria || translate('tasks.outcomeUnrecorded', 'Not recorded')}
      </p>
      {card.task_plan?.completion_mode === 'deployment' && (
        <p className="text-xs text-muted-foreground">
          {translate('tasks.deploymentOutcome', 'Deployment')} {card.task_plan.deployment_target}
        </p>
      )}
      <p className="line-clamp-2 text-xs">
        {translate('unifiedWork.5693e770dd67', 'Next:')}{' '}
        {next?.what ??
          card.next_action ??
          translate('unifiedWork.7da2cba119a8', 'Next action not recorded')}
      </p>
      {column === 'waiting' && (
        <p className="text-xs text-muted-foreground">
          {translate('unifiedWork.adcf88e3b8c2', 'Waiting:')}{' '}
          {card.kanban_reason ??
            next?.why ??
            (typeof card.blocked === 'string'
              ? card.blocked
              : typeof card.blocked === 'object' && card.blocked
                ? card.blocked.text
                : card.execution_reason) ??
            translate('unifiedWork.71e8f3f55213', 'Reason not reported')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {card.due_date
          ? translate('unifiedWork.d2cccdf0dac4', 'Due {{value0}}', { value0: card.due_date })
          : translate('tasks.noDueDate', 'No due date')}{' '}
        · {related.reduce((n, row) => n + row.repliesWaiting, 0)}{' '}
        {translate('unifiedWork.b994278263e7', 'replies')}
      </p>
      <span className="font-mono text-[11px] text-muted-foreground">{card.id}</span>
    </button>
  )
}
