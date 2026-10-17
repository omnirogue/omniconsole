import { useCallback, useEffect, useState } from 'react'
import { Link2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import {
  redactRestrictedDependencies,
  type TaskDependencyCondition,
  type TaskDependencyEdge,
  type TaskDependencyGraph
} from '../../../../shared/task-dependencies-contract'
import {
  dependencyAddRefusal,
  dependencyLinkageComplete,
  taskDependencyRefusalMessage,
  withAddedDependency,
  withRestoredDependency,
  withoutDependency
} from './task-dependencies-model'
import { DependencyRow, HiddenRow } from './TaskDependencyRows'
import { TaskDependencyPicker } from './TaskDependencyPicker'

/** "Depends on" and "Blocks" for one task, with add and remove written through the hub. */
export function TaskDependenciesSection({
  taskId,
  taskStatus,
  onOpenTask
}: {
  taskId: string
  /** The task's hub status; the hub only accepts dependency edits while it is open. */
  taskStatus?: string | null
  onOpenTask?: (taskId: string) => void
}): React.JSX.Element {
  const [graph, setGraph] = useState<TaskDependencyGraph | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [condition, setCondition] = useState<TaskDependencyCondition>('DONE')
  const [confirming, setConfirming] = useState<TaskDependencyEdge | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const answer = workflowData(await consoleWorkflowApi().listTaskDependencies({ taskId }))
      // Why redact here too: the main client already does, but a renderer must never trust that.
      setGraph(redactRestrictedDependencies(answer))
    } catch (reason) {
      setError(taskDependencyRefusalMessage(reason))
    }
  }, [taskId])
  useEffect(() => {
    void load()
  }, [load])

  const add = async (card: WorkCard): Promise<void> => {
    setPicking(false)
    setError('')
    const optimistic: TaskDependencyEdge = {
      task_id: card.id,
      title: card.title,
      status: card.status,
      condition,
      state: 'waiting',
      reason: null
    }
    setGraph((current) => (current ? withAddedDependency(current, optimistic) : current))
    try {
      const edge = workflowData(
        await consoleWorkflowApi().addTaskDependency({
          taskId,
          dependsOnTaskId: card.id,
          condition
        })
      )
      setGraph((current) =>
        current
          ? withAddedDependency(current, { ...edge, title: edge.title ?? card.title })
          : current
      )
    } catch (reason) {
      setGraph((current) => (current ? withoutDependency(current, card.id) : current))
      setError(taskDependencyRefusalMessage(reason))
    }
  }

  const remove = async (edge: TaskDependencyEdge): Promise<void> => {
    setConfirming(null)
    setError('')
    const index = (graph?.depends_on ?? []).findIndex((entry) => entry.task_id === edge.task_id)
    setGraph((current) => (current ? withoutDependency(current, edge.task_id) : current))
    try {
      workflowData(
        await consoleWorkflowApi().removeTaskDependency({ taskId, dependsOnTaskId: edge.task_id })
      )
    } catch (reason) {
      setGraph((current) =>
        current ? withRestoredDependency(current, edge, Math.max(index, 0)) : current
      )
      setError(taskDependencyRefusalMessage(reason))
    }
  }

  const hidden = graph?.hidden ?? { depends_on: 0, dependents: 0, blocking: 0 }
  const unavailable = graph !== null && (graph.depends_on === null || graph.dependents === null)
  // Why named: an Add the hub would certainly refuse is disabled with its reason, never offered.
  const addRefusal =
    dependencyAddRefusal(taskStatus) ??
    (graph !== null && !dependencyLinkageComplete(graph)
      ? translate(
          'taskDependencies.addUnknownLinks',
          "Some of this task's dependencies could not be read, so a new one cannot be offered safely."
        )
      : null)
  return (
    <section className="space-y-2" data-task-dependencies={taskId}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {translate('taskDependencies.title', 'Dependencies')}
        </h4>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={graph === null || graph.depends_on === null || addRefusal !== null}
          onClick={() => setPicking(true)}
        >
          <Link2 className="size-3" />
          {translate('taskDependencies.add', 'Add dependency')}
        </Button>
      </div>
      {addRefusal ? (
        <p className="text-xs text-muted-foreground" data-task-dependencies-add-refusal>
          {addRefusal}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {(error && graph === null) || unavailable ? (
        <Button type="button" size="xs" variant="ghost" onClick={() => void load()}>
          <RotateCw className="size-3" />
          {translate('taskDependencies.retry', 'Read again')}
        </Button>
      ) : null}
      {graph === null && !error ? (
        <p className="text-xs text-muted-foreground">
          {translate('taskDependencies.loading', 'Reading dependencies…')}
        </p>
      ) : null}
      {graph?.truncated ? (
        <p className="text-xs text-destructive" data-task-dependencies-truncated>
          {translate(
            'taskDependencies.truncatedSection',
            'This task has more dependencies than the console will list, so some are not shown here.'
          )}
        </p>
      ) : null}
      {graph ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('taskDependencies.dependsOn', 'Depends on')}
            </div>
            {graph.depends_on === null ? (
              <p className="text-xs text-destructive" data-task-dependencies-unavailable="upstream">
                {translate(
                  'taskDependencies.upstreamUnavailable',
                  'What this task depends on could not be read.'
                )}
              </p>
            ) : graph.depends_on.length === 0 && hidden.depends_on === 0 ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'taskDependencies.noneUpstream',
                  'This task does not wait on another task.'
                )}
              </p>
            ) : (
              <ul className="space-y-1">
                {graph.depends_on.map((edge) => (
                  <DependencyRow
                    key={edge.task_id}
                    edge={edge}
                    onOpenTask={onOpenTask}
                    onRemove={() => setConfirming(edge)}
                  />
                ))}
                <HiddenRow count={hidden.depends_on} blocking={hidden.blocking} />
              </ul>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('taskDependencies.blocks', 'Blocks')}
            </div>
            {graph.dependents === null ? (
              <p
                className="text-xs text-destructive"
                data-task-dependencies-unavailable="downstream"
              >
                {translate(
                  'taskDependencies.downstreamUnavailable',
                  'The tasks waiting on this one could not be read.'
                )}
              </p>
            ) : graph.dependents.length === 0 && hidden.dependents === 0 ? (
              <p className="text-xs text-muted-foreground">
                {translate('taskDependencies.noneDownstream', 'No task waits on this one.')}
              </p>
            ) : (
              <ul className="space-y-1">
                {graph.dependents.map((edge) => (
                  <DependencyRow key={edge.task_id} edge={edge} onOpenTask={onOpenTask} />
                ))}
                <HiddenRow count={hidden.dependents} blocking={0} />
              </ul>
            )}
          </div>
        </div>
      ) : null}
      <TaskDependencyPicker
        taskId={taskId}
        graph={graph}
        open={picking}
        onOpenChange={setPicking}
        condition={condition}
        onCondition={setCondition}
        onPick={(card) => void add(card)}
      />
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('taskDependencies.removeTitle', 'Remove this dependency?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'taskDependencies.removeWhy',
                'This task will no longer wait on "{{title}}".',
                { title: confirming?.title ?? confirming?.task_id ?? '' }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              {translate('taskDependencies.keep', 'Keep')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => confirming && void remove(confirming)}
            >
              {translate('taskDependencies.confirmRemove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
