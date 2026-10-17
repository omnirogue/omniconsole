import { Archive, ArchiveRestore, Circle, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { describeNextActor } from './backoffice-work-labels'
import { workRowKindLabel } from './backoffice-work-kind-label'

export function formatDue(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, { month: 'short', day: 'numeric' })
}

/** The server holds more tasks than the feed read so far; the person asks for the next pages. */
export type WorkListLoadMore = { pending: boolean; onLoadMore: () => void }

function LoadMoreTasks({ loadMore }: { loadMore: WorkListLoadMore }): React.JSX.Element {
  return (
    <div className="p-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        disabled={loadMore.pending}
        onClick={loadMore.onLoadMore}
        data-work-load-more=""
      >
        {loadMore.pending
          ? translate('backofficeWork.loadingMore', 'Loading more tasks…')
          : translate('backofficeWork.loadMore', 'Load more tasks')}
      </Button>
    </div>
  )
}

/** The request list half of the list/detail layout: one row per obligation. */
export function BackofficeWorkList({
  rows,
  selectedKey,
  names,
  emptyText,
  onSelect,
  loadMore,
  actions,
  readState
}: {
  rows: readonly WorkRow[]
  selectedKey: string | null
  names: ReadonlyMap<string, string>
  emptyText: string
  onSelect: (key: string) => void
  readState?: {
    isUnread: (row: WorkRow) => boolean
    toggle: (row: WorkRow) => void
    canMark?: (row: WorkRow) => boolean
  }
  /** Present while the Todo feed has a next page. */
  actions?: {
    selected: string[]
    selectable: string[]
    pending: boolean
    archived?: boolean
    removalLabel?: 'archive' | 'delete'
    onToggle: (key: string) => void
    onArchive: (key: string) => void
  }
  loadMore?: WorkListLoadMore
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div>
        <div className="p-4 text-sm text-muted-foreground">{emptyText}</div>
        {loadMore ? <LoadMoreTasks loadMore={loadMore} /> : null}
      </div>
    )
  }
  return (
    <div>
      <ul className="divide-y divide-border/40">
        {rows.map((row) => {
          const selected = row.key === selectedKey
          const unread = readState?.isUnread(row) ?? false
          return (
            <li key={row.key} className="flex items-center">
              {readState && (readState.canMark?.(row) ?? true) ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-2 shrink-0"
                  aria-label={
                    unread
                      ? translate('inbox.markRead', 'Mark as read')
                      : translate('inbox.markUnread', 'Mark as unread')
                  }
                  onClick={() => readState.toggle(row)}
                >
                  <Circle
                    className={cn('size-2', unread ? 'fill-current' : 'text-muted-foreground')}
                  />
                </Button>
              ) : null}
              {actions?.selectable.includes(row.key) ? (
                <Checkbox
                  className="ml-2 shrink-0"
                  aria-label={translate('workActions.selectTask', 'Select {{title}}', {
                    title: row.title
                  })}
                  disabled={actions.pending}
                  checked={actions.selected.includes(row.key)}
                  onCheckedChange={() => actions.onToggle(row.key)}
                />
              ) : null}
              <button
                type="button"
                data-work-row={row.key}
                data-current={selected ? 'true' : undefined}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(row.key)}
                className={cn(
                  'flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent',
                  selected && 'bg-accent'
                )}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span
                    className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')}
                  >
                    {row.title}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {workRowKindLabel(row)}
                  </Badge>
                  {row.repliesWaiting > 0 ? (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {translate('backofficeWork.repliesWaiting', '{{count}} unread', {
                        count: row.repliesWaiting
                      })}
                    </Badge>
                  ) : null}
                </span>
                <span className="flex w-full min-w-0 gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{describeNextActor(row, names)}</span>
                  {row.dueAt ? (
                    <span className="shrink-0">
                      {translate('backofficeWork.due', 'due {{date}}', {
                        date: formatDue(row.dueAt)
                      })}
                    </span>
                  ) : null}
                </span>
              </button>
              {actions?.selectable.includes(row.key) ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="mr-2 shrink-0"
                      disabled={actions.pending}
                      aria-label={
                        actions.archived
                          ? translate('workActions.restoreItem', 'Restore {{title}}', {
                              title: row.title
                            })
                          : actions.removalLabel === 'delete'
                            ? translate('inbox.deleteItem', 'Delete {{title}}', {
                                title: row.title
                              })
                            : translate('workActions.archiveTask', 'Archive {{title}}', {
                                title: row.title
                              })
                      }
                      onClick={() => actions.onArchive(row.key)}
                    >
                      {actions.archived ? (
                        <ArchiveRestore className="size-3.5" />
                      ) : actions.removalLabel === 'delete' ? (
                        <Trash2 className="size-3.5" />
                      ) : (
                        <Archive className="size-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {actions.archived
                      ? translate('workActions.restore', 'Restore')
                      : actions.removalLabel === 'delete'
                        ? translate('inbox.delete', 'Delete')
                        : translate('auto.components.TaskPage.archive', 'Archive')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </li>
          )
        })}
      </ul>
      {loadMore ? <LoadMoreTasks loadMore={loadMore} /> : null}
    </div>
  )
}
