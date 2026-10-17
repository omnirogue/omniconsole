import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { TaskDependencyEdge } from '../../../../shared/task-dependencies-contract'
import {
  dependencyChip,
  dependencyConditionLabel,
  dependencyEdgeDegraded
} from './task-dependencies-model'

const CHIP_TONE = {
  muted: 'border-border bg-muted text-muted-foreground',
  done: 'border-border bg-secondary text-secondary-foreground',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive'
} as const

export function DependencyRow({
  edge,
  onOpenTask,
  onRemove
}: {
  edge: TaskDependencyEdge
  onOpenTask?: (taskId: string) => void
  onRemove?: () => void
}) {
  const chip = dependencyChip(edge)
  const title = edge.title ?? edge.task_id
  return (
    <li className="space-y-0.5" data-task-dependency={edge.task_id}>
      <div className="flex min-w-0 items-center gap-2">
        {onOpenTask ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm underline-offset-2 hover:underline"
            onClick={() => onOpenTask(edge.task_id)}
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        )}
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[11px]',
            CHIP_TONE[chip.tone]
          )}
          data-dependency-state={edge.state ?? 'unknown'}
        >
          {chip.label}
        </span>
        <span
          className="shrink-0 text-[11px] text-muted-foreground"
          data-dependency-condition={edge.condition ?? 'unknown'}
        >
          {dependencyConditionLabel(edge.condition)}
        </span>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('taskDependencies.remove', 'Remove dependency on {{title}}', {
              title
            })}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      {dependencyEdgeDegraded(edge) ? (
        <p className="text-xs text-muted-foreground" data-task-dependency-degraded>
          {translate(
            'taskDependencies.edgeUnreadable',
            'This dependency could not be read in full, so whether it is met is unknown.'
          )}
        </p>
      ) : null}
      {edge.reason ? (
        <p
          className={cn(
            'text-xs',
            chip.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {edge.reason}
        </p>
      ) : null}
    </li>
  )
}

/** Tasks this reader may not open: a count only, never which task or its state. */
export function HiddenRow({ count, blocking }: { count: number; blocking: number }) {
  if (count === 0) {
    return null
  }
  return (
    <li
      className={cn('text-xs', blocking > 0 ? 'text-destructive' : 'text-muted-foreground')}
      data-task-dependency-hidden={count}
    >
      {blocking > 0
        ? translate(
            'taskDependencies.hiddenBlocking',
            "{{count}} more you cannot open, and at least one can't be met",
            { count }
          )
        : translate('taskDependencies.hiddenTasks', '{{count}} more you cannot open', { count })}
    </li>
  )
}
