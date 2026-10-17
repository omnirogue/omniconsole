import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  consoleWorkflowApi,
  isStaleWorkflowResponse,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleTaskRecord } from '../../../../shared/console-workflow-types'
import { WorkflowError, WorkflowTextField } from './WorkflowFields'
import { useWorkflowRequest } from './use-workflow-request'

/** One card as the server holds it; the observed revision fences every write made from it. */
export function useConsoleTask(taskId: string): {
  task: ConsoleTaskRecord | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [task, setTask] = useState<ConsoleTaskRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Why: overlapping reads (mount, a save) settle last-finisher-wins otherwise; only the latest
  // ask may write, and none after the editor is gone.
  const ask = useRef(0)
  const live = useRef(true)
  const refresh = useCallback(async () => {
    const mine = ++ask.current
    const current = (): boolean => live.current && mine === ask.current
    setLoading(true)
    try {
      const observed = workflowData(await consoleWorkflowApi().getTask({ taskId }))
      if (observed.id !== taskId) {
        throw new Error('The server returned a different task identity.')
      }
      if (current()) {
        setTask(observed)
        setError(null)
      }
    } catch (failure) {
      if (current()) {
        setError(workflowErrorMessage(failure))
        setTask(null)
      }
    } finally {
      if (current()) {
        setLoading(false)
      }
    }
  }, [taskId])
  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
  }, [refresh])
  return { task, loading, error, refresh }
}

/** The card's next action, saved against the revision the person saw; a stale save re-reads first. */
export function TaskNextActionEditor({
  taskId,
  task,
  loading,
  onSaved
}: {
  taskId: string
  task: ConsoleTaskRecord | null
  loading: boolean
  /** Called after a save the server accepted; the caller re-reads the card. */
  onSaved: () => Promise<void>
}) {
  const [nextAction, setNextAction] = useState(task?.next_action ?? '')
  const request = useWorkflowRequest()
  // Why: a re-read (after a stale save, or a refresh) is the server's word; the field follows it.
  useEffect(() => {
    setNextAction(task?.next_action ?? '')
  }, [task])
  const save = () =>
    void request.run(async () => {
      if (task?.state_revision == null) {
        return
      }
      try {
        workflowData(
          await consoleWorkflowApi().updateTask({
            taskId,
            expectedRevision: task.state_revision,
            nextAction
          })
        )
        await onSaved()
      } catch (error) {
        if (isStaleWorkflowResponse(error)) {
          await onSaved()
        }
        throw error
      }
    })
  if (!task) {
    return <WorkflowError message={request.error} />
  }
  return (
    <>
      <WorkflowTextField
        label={translate('consoleWorkflows.nextAction', 'Next action')}
        value={nextAction}
        onChange={setNextAction}
        disabled={loading || request.pending}
        multiline
      />
      <Button
        size="sm"
        disabled={
          loading ||
          request.pending ||
          task.state_revision == null ||
          nextAction === (task.next_action ?? '')
        }
        onClick={save}
      >
        {translate('consoleWorkflows.saveNextAction', 'Save next action')}
      </Button>
      {task.state_revision == null && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'consoleWorkflows.noRevision',
            'This server view has no task revision; changes are unavailable.'
          )}
        </p>
      )}
      <WorkflowError message={request.error} />
    </>
  )
}
