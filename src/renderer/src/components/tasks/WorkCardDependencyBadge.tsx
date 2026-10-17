import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { translate } from '@/i18n/i18n'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import {
  redactRestrictedDependencies,
  type TaskDependencyEdge
} from '../../../../shared/task-dependencies-contract'
import {
  dependencyBadge,
  dependencyBadgeLabel,
  dependencyChip,
  taskDependencyRefusalMessage
} from './task-dependencies-model'

type Blockers = {
  key: string
  edges: TaskDependencyEdge[] | null
  hidden: number
  truncated: boolean
  error: string
}

/** "Waiting on N" or "Can't proceed" from the card's dependency_summary; the blockers load on hover. */
export function WorkCardDependencyBadge({
  card
}: {
  card: Pick<WorkCard, 'id' | 'dependency_summary' | 'kanban_badges'>
}): React.JSX.Element | null {
  const badge = dependencyBadge(card.dependency_summary)
  const summary = card.dependency_summary
  // Why keyed: a board refresh that changes the card or its counts must re-read the blockers.
  const key = [card.id, summary?.waiting, summary?.unmeetable, summary?.missing].join('|')
  const [loaded, setLoaded] = useState<Blockers | null>(null)
  const current = loaded?.key === key ? loaded : null
  if (!badge) {
    return null
  }
  const open = (next: boolean): void => {
    if (!next) {
      // Why dropped on close: the counts can stay identical while a blocker's title, reason or
      // identity changes, so a kept answer would freeze the first read forever.
      setLoaded(null)
      return
    }
    // A read in flight or already answered for this key is kept; a refusal is retried.
    if (current && !current.error) {
      return
    }
    setLoaded({ key, edges: null, hidden: 0, truncated: false, error: '' })
    const settle = (patch: Partial<Blockers>) =>
      setLoaded((prev) => (prev?.key === key ? { ...prev, ...patch } : prev))
    void consoleWorkflowApi()
      .listTaskDependencies({ taskId: card.id })
      .then((result) => {
        const graph = redactRestrictedDependencies(workflowData(result))
        if (graph.depends_on === null) {
          settle({
            error: translate(
              'taskDependencies.upstreamUnavailable',
              'What this task depends on could not be read.'
            )
          })
          return
        }
        settle({
          edges: graph.depends_on.filter((edge) => edge.state !== 'satisfied'),
          hidden: graph.hidden?.depends_on ?? 0,
          truncated: graph.truncated === true
        })
      })
      .catch((reason: unknown) => settle({ error: taskDependencyRefusalMessage(reason) }))
  }
  return (
    <HoverCard openDelay={150} onOpenChange={open}>
      <HoverCardTrigger asChild>
        <Badge
          variant={badge.kind === 'unmeetable' ? 'destructive' : 'outline'}
          className="text-[11px]"
          tabIndex={0}
          data-work-dependency-badge={badge.kind}
        >
          {dependencyBadgeLabel(badge, card.kanban_badges)}
        </Badge>
      </HoverCardTrigger>
      {/* Why stopPropagation: the badge sits inside the card's open-task button; portals still bubble. */}
      <HoverCardContent
        className="w-72 space-y-1 p-3 text-xs"
        onClick={(event) => event.stopPropagation()}
      >
        {current?.error ? (
          <p role="alert" className="text-destructive">
            {current.error}
          </p>
        ) : !current || current.edges === null ? (
          <p className="text-muted-foreground">
            {translate('taskDependencies.loading', 'Reading dependencies…')}
          </p>
        ) : (
          <ul className="space-y-1" data-work-dependency-blockers>
            {current.edges.map((edge) => (
              <li key={edge.task_id}>
                <span className="font-medium">{edge.title ?? edge.task_id}</span>
                <span className="ml-1 text-muted-foreground">· {dependencyChip(edge).label}</span>
                {edge.reason ? <p className="text-muted-foreground">{edge.reason}</p> : null}
              </li>
            ))}
            {current.truncated ? (
              <li className="text-muted-foreground" data-work-dependency-truncated>
                {translate(
                  'taskDependencies.truncated',
                  'Too many dependencies to list; open the task to see them all.'
                )}
              </li>
            ) : null}
            {current.hidden > 0 ? (
              <li className="text-muted-foreground" data-work-dependency-hidden>
                {translate('taskDependencies.hiddenTasks', '{{count}} more you cannot open', {
                  count: current.hidden
                })}
              </li>
            ) : null}
          </ul>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
