import { useEffect, useMemo, useState } from 'react'
import { Link2, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { isClosedTaskStatus } from '../../../../shared/task-state'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import { handoffApi } from './handoff-client'

/**
 * Bind an unbound handoff thread to a task that already exists. `AttachToTaskDialog`
 * is built around attaching a live session and is not task-agnostic, so this reads its
 * own task list from `listWork()` and calls `bindThread` instead.
 */
export function HandoffTaskAttachDialog({
  threadId,
  onOpenChange,
  onBound
}: {
  threadId: string | null
  onOpenChange: (open: boolean) => void
  onBound?: (taskId: string) => void
}): React.JSX.Element {
  const [cards, setCards] = useState<WorkCard[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (!threadId) {
      return
    }
    let live = true
    setCards(null)
    setLoadError('')
    void consoleWorkflowApi()
      .listWork()
      .then((result) => {
        if (live) {
          setCards(workflowData(result).items)
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setLoadError(workflowErrorMessage(reason))
        }
      })
    return () => {
      live = false
    }
  }, [threadId])
  const tasks = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (cards ?? [])
      .filter(
        (card) =>
          !isClosedTaskStatus(card.status) && card.kanban_eligible !== false && !card.parent_task_id
      )
      .filter((card) => (q ? card.title.toLowerCase().includes(q) : true))
      .slice(0, 40)
  }, [cards, query])
  const bind = async (taskId: string): Promise<void> => {
    if (!threadId || busy !== null) {
      return
    }
    setBusy(taskId)
    try {
      workflowData(await handoffApi().bindThread({ threadId, taskId }))
      toast.success(translate('handoffs.boundToTask', 'This request now belongs to a task.'))
      onBound?.(taskId)
      onOpenChange(false)
    } catch (reason) {
      toast.error(workflowErrorMessage(reason))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open={threadId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Link2 className="size-4" />
            {translate('handoffs.attachToTask', 'Attach to task…')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'handoffs.attachToTaskWhy',
              'This request becomes part of work that is already being tracked.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-7 text-xs"
            aria-label={translate('tasks.findTask', 'Find a task')}
            placeholder={translate('tasks.findTask', 'Find a task')}
          />
        </div>
        {loadError && (
          <p role="alert" className="text-xs text-destructive">
            {loadError}
          </p>
        )}
        <div
          className="scrollbar-sleek max-h-[45vh] space-y-px overflow-y-auto"
          data-attach-task-list
        >
          {tasks.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              {cards === null
                ? translate('tasks.loading', 'Reading your work…')
                : translate('tasks.noOpenTasks', 'No open tasks match.')}
            </p>
          ) : (
            tasks.map((card) => (
              <button
                key={card.id}
                type="button"
                disabled={busy !== null}
                onClick={() => void bind(card.id)}
                data-attach-task={card.id}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
              >
                {busy === card.id ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{card.title}</span>
                {card.company_slug ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {card.company_slug}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
