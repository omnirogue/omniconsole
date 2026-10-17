import { useEffect, useState } from 'react'
import { Monitor, Square, Terminal } from 'lucide-react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  ConsoleLocalExecutionApi,
  ConsoleLocalExecutionView
} from '../../../../shared/console-local-execution'
import { workflowData, workflowErrorMessage } from '@/lib/console-workflow-client'
import { WorkflowError, WorkflowSelect, WorkflowValue } from './WorkflowFields'
import { workflowWorkspaceOptions } from './workflow-workspace-options'
import { useWorkflowRequest } from './use-workflow-request'

function localApi(): ConsoleLocalExecutionApi {
  const api = window.api.consoleLocalExecution
  if (!api) {
    throw new Error('Local workflow execution is unavailable in this version of OmniConsole.')
  }
  return api
}

export function WorkflowLocalExecution({
  jobId,
  workflowId,
  digest,
  canStart,
  onRefresh
}: {
  jobId: string
  workflowId: string
  digest: string
  canStart: boolean
  onRefresh: () => void
}) {
  const worktrees = useAllWorktrees()
  const folders = useAppStore((state) => state.folderWorkspaces)
  const [worktree, setWorktree] = useState('')
  const [execution, setExecution] = useState<ConsoleLocalExecutionView | null>(null)
  const [transcript, setTranscript] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const request = useWorkflowRequest()
  const { run } = request
  const options = workflowWorkspaceOptions(worktrees, folders)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const executions = workflowData(await localApi().list())
        if (!cancelled) {
          setExecution(executions.find((item) => item.jobId === jobId) ?? null)
          setReadError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setReadError(workflowErrorMessage(error))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jobId])
  const start = () =>
    void run(async () => {
      if (!canStart || !worktree || execution || loading || readError) {
        return
      }
      setExecution(
        workflowData(
          await localApi().start({ jobId, workflowId, approvedDigest: digest, worktree })
        )
      )
      onRefresh()
    })
  return (
    <section className="space-y-3 border-t border-border pt-3">
      <h3 className="text-sm font-medium">
        {translate('consoleWorkflows.localExecution', 'Local execution')}
      </h3>
      {execution ? (
        <>
          <dl className="space-y-2">
            <WorkflowValue
              label={translate('consoleWorkflows.executionState', 'Execution state')}
              value={execution.state}
            />
            <WorkflowValue
              label={translate('consoleWorkflows.branch', 'Branch')}
              value={execution.branch}
            />
            <WorkflowValue
              label={translate('consoleWorkflows.executionError', 'Execution error')}
              value={execution.error}
            />
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={request.pending || !execution.terminalHandle}
              onClick={() =>
                void run(async () => {
                  workflowData(await localApi().focus({ jobId }))
                })
              }
            >
              <Terminal />
              {translate('consoleWorkflows.openTerminal', 'Open terminal')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={request.pending}
              onClick={() =>
                void run(async () => {
                  setTranscript(workflowData(await localApi().readWorker({ jobId, limit: 12000 })))
                })
              }
            >
              {translate('consoleWorkflows.readTranscript', 'Read transcript')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                request.pending || ['exited', 'cancelled', 'failed'].includes(execution.state)
              }
              onClick={() =>
                void run(async () => {
                  setExecution(workflowData(await localApi().cancel({ jobId })))
                  onRefresh()
                })
              }
            >
              <Square />
              {translate('consoleWorkflows.stopLocalJob', 'Stop local job')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <WorkflowSelect
            label={translate('consoleWorkflows.workspace', 'Workspace')}
            value={worktree}
            onChange={setWorktree}
            disabled={loading || !!readError || request.pending || !canStart}
            options={options}
          />
          <Button
            size="sm"
            disabled={loading || !!readError || request.pending || !canStart || !worktree}
            onClick={start}
          >
            <Monitor />
            {translate('consoleWorkflows.startLocally', 'Start this job locally')}
          </Button>
          {!canStart && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'consoleWorkflows.localUnavailable',
                'The server has not marked this job ready for local execution.'
              )}
            </p>
          )}
        </>
      )}
      <WorkflowError message={request.error} />
      <WorkflowError message={readError} />
      {transcript != null && (
        <pre
          aria-label={translate('consoleWorkflows.transcript', 'Transcript')}
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words scrollbar-sleek font-mono text-xs"
        >
          {typeof transcript === 'string' ? transcript : JSON.stringify(transcript, null, 2)}
        </pre>
      )}
    </section>
  )
}
