import { translate } from '@/i18n/i18n'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NewTaskButton } from '@/components/tasks/NewTaskButton'
import { Input } from '@/components/ui/input'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import {
  companySlugKey,
  isProposedTask,
  taskCompanySlugs
} from '../../../../../shared/proposed-task'
import { BackofficeWorkBoardCard } from './backoffice-work-board-card'
import { BackofficeWorkBoardColumns } from './backoffice-work-board-columns'
import { workColumn, type WorkColumn } from './work-kanban-presentation'

import { useWorkBoardData } from './use-work-board-data'
export { workColumn } from './work-kanban-presentation'
export { WORK_REFRESH_MS } from './use-work-board-data'
const UNFILED = 'Unfiled'
/** Every company a card is for, or the one word the filters use for a card with none. */
function cardCompanies(card: WorkCard): string[] {
  const companies = taskCompanySlugs(card.company_slug, card.tags)
  return companies.length > 0 ? companies : [UNFILED]
}
type View = { company: string; domain: string; mode: 'board' | 'list' | 'timeline'; query: string }
const initial: View = { company: '', domain: '', mode: 'board', query: '' }
function readView(scope: string): View {
  try {
    const value = JSON.parse(localStorage.getItem(`work-home:${scope}`) ?? '{}')
    return {
      company:
        typeof value.company === 'string'
          ? value.company.trim().toLowerCase() === 'unfiled'
            ? UNFILED
            : companySlugKey(value.company)
          : '',
      domain: typeof value.domain === 'string' ? value.domain : '',
      mode: ['board', 'list', 'timeline'].includes(value.mode) ? value.mode : 'board',
      query: ''
    }
  } catch {
    return initial
  }
}
export function BackofficeWorkBoard({
  scope,
  rows,
  names,
  viewer = null,
  refreshKey = 0,
  onOpenTask,
  onEditTask
}: {
  scope: string
  rows: readonly WorkRow[]
  names: ReadonlyMap<string, string>
  viewer?: string | null
  refreshKey?: number
  onOpenTask: (id: string, card?: WorkCard) => void
  onEditTask?: (id: string, card?: WorkCard) => void
}) {
  const [view, setView] = useState(() => readView(scope))
  const [personal, setPersonal] = useState(true)
  const [revision, setRevision] = useState(0)
  const { data, error, updated, refresh } = useWorkBoardData(scope, refreshKey, revision)
  const [moving, setMoving] = useState<ReadonlyMap<string, WorkCard>>(new Map())
  const movePending = (card: WorkCard, pending: boolean) =>
    setMoving((current) => {
      const next = new Map(current)
      if (pending) {
        next.set(card.id, card)
      } else {
        next.delete(card.id)
      }
      return next
    })
  const moved = async (taskId: string, target: WorkColumn) => {
    const board = await refresh()
    const card = board.items.find((item) => item.id === taskId)
    if (!card || workColumn(card) !== target) {
      throw new Error(
        'The move was sent, but the latest board has not confirmed its column. Refresh to check the task before moving it again.'
      )
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(`work-home:${scope}`, JSON.stringify(view))
      } catch {
        /* Storage is optional. */
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [scope, view])
  const change = (patch: Partial<View>) => {
    const next = { ...view, ...patch }
    setView(next)
    if (patch.query === undefined) {
      try {
        localStorage.setItem(`work-home:${scope}`, JSON.stringify(next))
      } catch {
        /* Storage is optional. */
      }
    }
  }
  const relatedByTask = useMemo(() => {
    const grouped = new Map<string, WorkRow[]>()
    for (const row of rows) {
      if (!row.taskId) {
        continue
      }
      const group = grouped.get(row.taskId) ?? []
      group.push(row)
      grouped.set(row.taskId, group)
    }
    return grouped
  }, [rows])
  // Why keyed by the normalised slug: card tags and the hub's own slugs may differ in case.
  const companyName = new Map(
    data?.companies?.map((company) => [companySlugKey(company.slug), company.name])
  )
  const domainName = new Map(
    data?.companies?.flatMap((company) =>
      company.domains.map((domain) => [domain.id, domain.name] as const)
    )
  )
  const companies = [
    ...new Set([
      ...(data?.companies?.map((company) => companySlugKey(company.slug)) ?? []),
      ...(data?.items.flatMap(cardCompanies) ?? [])
    ])
  ].sort()
  const domains = [
    ...new Set([
      ...(data?.companies
        ?.filter((company) => !view.company || companySlugKey(company.slug) === view.company)
        .flatMap((company) => company.domains.map((domain) => domain.id)) ?? []),
      ...(data?.items
        .filter((card) => !view.company || cardCompanies(card).includes(view.company))
        .map((card) => card.org_unit_id ?? UNFILED) ?? [])
    ])
  ].sort()
  const cards = useMemo(
    () =>
      (data?.items ?? [])
        .map((card) => moving.get(card.id) ?? card)
        .filter(
          (card) =>
            (isProposedTask(card.tags) ||
              !personal ||
              (!!viewer && card.owner_employee_id === viewer)) &&
            (!view.company || cardCompanies(card).includes(view.company)) &&
            (!view.domain || (card.org_unit_id ?? UNFILED) === view.domain) &&
            `${card.title} ${card.id} ${card.description ?? ''}`
              .toLowerCase()
              .includes(view.query.toLowerCase())
        ),
    [data, view, personal, viewer, moving]
  )
  const renderCard = (card: WorkCard) => (
    <BackofficeWorkBoardCard
      key={card.id}
      card={card}
      related={relatedByTask.get(card.id) ?? []}
      names={names}
      companyNames={companyName}
      domainName={domainName.get(card.org_unit_id ?? '')}
      mode={view.mode}
      column={workColumn(card)}
      onOpenTask={(id) => onOpenTask(id, card)}
    />
  )
  // Why proposed cards bypass the source rule: the hub marks only IDE-sourced cards
  // board-eligible, but a card someone deliberately tagged as a proposal (from any chat
  // through the omnios MCP) is exactly what the Proposed lane exists to show.
  const activeCards = cards.filter(
    (card) =>
      !card.parent_task_id &&
      (isProposedTask(card.tags) ||
        (card.kanban_eligible ??
          ['omniconsole-ide', 'omniconsole-task'].includes(card.source ?? ''))) &&
      !['cancelled', 'archived'].includes(card.kanban_disposition ?? card.status) &&
      !['inbox', 'reference'].includes(card.triage_state ?? '')
  )
  const filing = {
    companyId: data?.companies?.find((company) =>
      view.company
        ? companySlugKey(company.slug) === view.company
        : company.domains.some((domain) => domain.id === view.domain)
    )?.id,
    unitId: view.domain && view.domain !== UNFILED ? view.domain : undefined
  }
  return (
    <section
      className="space-y-3 p-3"
      aria-label={translate('unifiedWork.281451e0a65d', 'Work board')}
    >
      <div className="flex flex-wrap gap-2">
        <NewTaskButton initialFiling={filing} onCreated={() => setRevision((value) => value + 1)} />
        <NewTaskButton
          proposed
          initialFiling={filing}
          onCreated={() => setRevision((value) => value + 1)}
        />
        <select
          aria-label={translate('tasks.taskOwner', 'Task owner')}
          value={personal ? 'mine' : 'visible'}
          onChange={(event) => setPersonal(event.target.value === 'mine')}
          className="rounded-md border border-input bg-background p-1 text-xs"
        >
          <option value="mine">{translate('tasks.myTasks', 'My tasks')}</option>
          <option value="visible">{translate('tasks.allVisibleTasks', 'All visible tasks')}</option>
        </select>
        <select
          aria-label={translate('unifiedWork.de4743c87973', 'Company')}
          value={view.company}
          onChange={(event) => change({ company: event.target.value, domain: '' })}
          className="rounded-md border border-input bg-background p-1 text-xs"
        >
          <option value="">{translate('unifiedWork.39b460136cb9', 'All companies')}</option>
          {companies.map((value) => (
            <option key={value} value={value}>
              {companyName.get(value) ?? value}
            </option>
          ))}
        </select>
        <select
          aria-label={translate('unifiedWork.79fa33618d8e', 'Domain')}
          value={view.domain}
          onChange={(event) => change({ domain: event.target.value })}
          className="rounded-md border border-input bg-background p-1 text-xs"
        >
          <option value="">{translate('unifiedWork.0f97da22f84f', 'All domains')}</option>
          {domains.map((value) => (
            <option key={value} value={value}>
              {domainName.get(value) ?? value}
            </option>
          ))}
        </select>
        {(['board', 'list', 'timeline'] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={view.mode === mode ? 'secondary' : 'ghost'}
            onClick={() => change({ mode })}
          >
            {mode === 'board'
              ? translate('unifiedWork.4816cbfd74aa', 'Board')
              : mode === 'list'
                ? translate('unifiedWork.6f202f54a7b2', 'List')
                : translate('unifiedWork.9dcff98e275f', 'Timeline')}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
          {translate('unifiedWork.0e9161011702', 'Refresh')}
        </Button>
        <Input
          aria-label={translate('unifiedWork.b8adfc4dd942', 'Search Work')}
          placeholder={translate('unifiedWork.46c6f1dea7e9', 'Search tasks')}
          value={view.query}
          onChange={(event) => change({ query: event.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'workKanban.proposalsVisible',
          'Proposed shows all visible ideas. The owner filter applies to committed work. Session requests stay in Needs You and Waiting For.'
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'unifiedWork.7c0372236c87',
          'Views are saved for this account. Refreshes every 30 seconds while visible.'
        )}{' '}
        {updated &&
          translate('unifiedWork.b87ea860d734', 'Last read {{value0}}.', { value0: updated })}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate('unifiedWork.8eba4f99ccea', 'Work unavailable:')}
          {error}
        </p>
      )}
      {personal && !viewer && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'tasks.personalIdentityPending',
            'Your employee identity is not available yet. Your Kanban will appear when it is confirmed.'
          )}
        </p>
      )}
      {!!data?.items.length && data.items.every((card) => card.tags === undefined) && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'workKanban.tagsUnavailable',
            'Console does not report tags; Proposed lane unavailable'
          )}
        </p>
      )}
      {data?.filingUnavailable && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'unifiedWork.fc8b6588fbef',
            'Company/domain names unavailable; saved IDs are shown.'
          )}
        </p>
      )}
      {data?.capped && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('unifiedWork.3563d1fe07fd', 'Partial board:')}
          {data.items.length}
          {translate('unifiedWork.28391d3bc64e', 'of')}
          {data.total}
          {translate('unifiedWork.402bcd1fa0a9', 'tasks returned.')}
        </p>
      )}
      {data && !(view.mode === 'board' ? activeCards : cards).length && (
        <p className="text-sm text-muted-foreground">
          {translate('unifiedWork.4afcde8a9677', 'No tasks in this view.')}
        </p>
      )}
      {view.mode === 'board' ? (
        <BackofficeWorkBoardColumns
          cards={activeCards}
          relatedByTask={relatedByTask}
          columnOf={workColumn}
          renderCard={renderCard}
          onEditTask={
            onEditTask
              ? (id) =>
                  onEditTask(
                    id,
                    cards.find((card) => card.id === id)
                  )
              : undefined
          }
          onMoved={moved}
          onMovePending={movePending}
        />
      ) : (
        <div className="space-y-2">
          {[...cards]
            .sort((a, b) =>
              view.mode === 'timeline' ? (b.updated_at ?? '').localeCompare(a.updated_at ?? '') : 0
            )
            .map(renderCard)}
        </div>
      )}
      {view.mode === 'board' && activeCards.length < cards.length && (
        <Button size="sm" variant="ghost" onClick={() => change({ mode: 'list' })}>
          {translate('workKanban.otherWork', 'View other work and closed records in List')}
        </Button>
      )}
    </section>
  )
}
