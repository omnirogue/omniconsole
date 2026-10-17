import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ConsoleJobRecord } from '../../../../shared/console-workflow-types'
import type { ConsoleLocalExecutionView } from '../../../../shared/console-local-execution'
import { workflowJobRows } from '@/lib/console-workflow-jobs'
import { WorkflowError } from './WorkflowFields'

export function WorkflowJobsList({
  taskId,
  onOpen
}: {
  taskId: string | null
  onOpen: (workflowId: string) => void
}) {
  const [jobs, setJobs] = useState<ConsoleJobRecord[]>([])
  const [executions, setExecutions] = useState<ConsoleLocalExecutionView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => {
          const api = consoleWorkflowApi()
          if (!api.listJobs) {
            throw new Error('The server jobs list is unavailable in this version of OmniConsole.')
          }
          return workflowData(await api.listJobs(taskId ? { taskId } : {})).jobs
        }),
        Promise.resolve().then(async () => {
          const api = window.api.consoleLocalExecution
          if (!api) {
            throw new Error(
              'The local execution list is unavailable in this version of OmniConsole.'
            )
          }
          return workflowData(await api.list())
        })
      ])
      if (!cancelled) {
        setJobs(results[0].status === 'fulfilled' ? results[0].value : [])
        setExecutions(results[1].status === 'fulfilled' ? results[1].value : [])
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [workflowErrorMessage(result.reason)] : []
        )
        setError(errors.length ? errors.join('\n') : null)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, revision])
  const rows = workflowJobRows(jobs, executions, taskId)
  return (
    <section className="space-y-3">
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => setRevision((value) => value + 1)}
      >
        {translate('consoleWorkflows.refreshJobs', 'Refresh jobs')}
      </Button>
      <WorkflowError message={error} />
      {!taskId && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'consoleWorkflows.localJobsScope',
            'Jobs activated on this computer and the server jobs in their workflows.'
          )}
        </p>
      )}
      {loading && (
        <p className="text-sm text-muted-foreground">
          {translate('consoleWorkflows.loadingJobs', 'Loading server jobs…')}
        </p>
      )}
      {!loading && !error && !rows.length && (
        <p className="text-sm text-muted-foreground">
          {taskId
            ? translate('consoleWorkflows.jobsEmpty', 'No jobs returned for this task.')
            : translate('consoleWorkflows.noLocalJobs', 'No jobs activated on this computer.')}
        </p>
      )}
      <ul className="divide-y divide-border">
        {rows.map(({ id, job, execution, workflowId }) => (
          <li key={id} className="flex flex-wrap items-center gap-2 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{job?.title ?? id}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {job?.task_id ?? execution?.cardId} · {job?.machine ?? '—'}
              </div>
              {execution?.terminalHandle && (
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {execution.terminalHandle}
                </div>
              )}
            </div>
            {execution && (
              <Badge variant="secondary">
                {translate('consoleWorkflows.local', 'Local')} · {execution.state}
              </Badge>
            )}
            {job && <Badge variant="outline">{job.status}</Badge>}
            <Button
              variant="outline"
              size="sm"
              disabled={!workflowId}
              onClick={() => {
                if (workflowId) {
                  onOpen(workflowId)
                }
              }}
            >
              {translate('consoleWorkflows.openWorkflow', 'Open workflow')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
