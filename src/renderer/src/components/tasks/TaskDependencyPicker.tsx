import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import type {
  TaskDependencyCondition,
  TaskDependencyGraph
} from '../../../../shared/task-dependencies-contract'
import {
  dependencyCandidates,
  dependencyConditionLabel,
  dependencyLinkageComplete,
  taskDependencyRefusalMessage
} from './task-dependencies-model'

/** Picks the prerequisite to add: open tasks only, and only while every edge is known. */
export function TaskDependencyPicker({
  taskId,
  graph,
  open,
  onOpenChange,
  condition,
  onCondition,
  onPick
}: {
  taskId: string
  graph: TaskDependencyGraph | null
  open: boolean
  onOpenChange: (open: boolean) => void
  condition: TaskDependencyCondition
  onCondition: (condition: TaskDependencyCondition) => void
  onPick: (card: WorkCard) => void
}): React.JSX.Element {
  const [cards, setCards] = useState<WorkCard[] | null>(null)
  const [pickError, setPickError] = useState('')
  const [query, setQuery] = useState('')
  // Why gated: with an unknown remainder no task can be called unlinked, so none is offered.
  const linkageComplete = dependencyLinkageComplete(graph)
  useEffect(() => {
    if (!open || cards !== null || !linkageComplete) {
      return
    }
    let live = true
    setPickError('')
    void consoleWorkflowApi()
      .listWork()
      .then((result) => live && setCards(workflowData(result).items))
      // Why inside the dialog: the picker is what is waiting; reopening it retries.
      .catch((reason: unknown) => live && setPickError(taskDependencyRefusalMessage(reason)))
    return () => {
      live = false
    }
  }, [open, cards, linkageComplete])
  const candidates = useMemo(
    () => dependencyCandidates(cards ?? [], taskId, graph, query),
    [cards, taskId, graph, query]
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('taskDependencies.pickTitle', 'This task depends on…')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'taskDependencies.pickWhy',
              'This task waits until the one you choose is done or verified.'
            )}
          </DialogDescription>
        </DialogHeader>
        {linkageComplete ? null : (
          <p className="text-xs text-destructive" data-dependency-picker-unavailable>
            {translate(
              'taskDependencies.pickUnavailable',
              'Not every dependency this task already has could be read, so no task can safely be offered as a new one.'
            )}
          </p>
        )}
        {linkageComplete ? (
          <>
            <div className="flex gap-1" role="group">
              {(['DONE', 'VERIFIED'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="xs"
                  variant={condition === value ? 'secondary' : 'ghost'}
                  aria-pressed={condition === value}
                  onClick={() => onCondition(value)}
                >
                  {dependencyConditionLabel(value)}
                </Button>
              ))}
            </div>
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
            <div className="scrollbar-sleek max-h-[45vh] space-y-px overflow-y-auto">
              {pickError ? (
                <p role="alert" className="px-1 py-3 text-xs text-destructive">
                  {pickError}
                </p>
              ) : candidates.length === 0 ? (
                <p className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
                  {cards === null ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : null}
                  {cards === null
                    ? translate('tasks.loading', 'Reading your work…')
                    : translate('tasks.noOpenTasks', 'No open tasks match.')}
                </p>
              ) : (
                candidates.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => onPick(card)}
                    data-dependency-candidate={card.id}
                    className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
                  >
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
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
