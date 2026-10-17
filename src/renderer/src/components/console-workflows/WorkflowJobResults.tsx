import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HandoffDetailView } from '@/components/handoffs/HandoffDetailView'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { downloadExactHandoffFile } from '@/components/handoffs/handoff-client'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage,
  downloadWorkflowExport
} from '@/lib/console-workflow-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { BOARD_TASK_ID_PATTERN } from '../../../../shared/board-task-id'
import type {
  ConsoleJobRecord,
  ConsoleWorkflowJob
} from '../../../../shared/console-workflow-types'
import type { ConsoleJobResults } from '../../../../shared/console-job-results'
import { WorkflowError } from './WorkflowFields'

type ResultJob = ConsoleJobRecord | ConsoleWorkflowJob

export function WorkflowJobResults({ job }: { job: ResultJob }) {
  const scope = useHandoffScope()
  return (
    <JobResults
      key={`${scope}:${job.id}:${job.attempt}:${job.execution_artifacts?.[0]?.sha256}`}
      job={job}
      scope={scope}
    />
  )
}

function JobResults({ job, scope }: { job: ResultJob; scope: string }) {
  const [result, setResult] = useState<ConsoleJobResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [threadOpen, setThreadOpen] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const receipt = job.execution_artifacts?.[0]
  const hasResult = receipt?.job_id === job.id && receipt.attempt === job.attempt
  const delivery = job.policy.person_handoff_delivery
  const request = job.policy.workflow?.person_handoff
  const deliveredThread =
    delivery?.status === 'delivered' &&
    delivery.job_id === job.id &&
    delivery.recipient_employee_id === request?.recipient_employee_id &&
    delivery.author_employee_id === request?.participants.director.employee_id
      ? delivery.thread_id
      : undefined
  const openTask = (taskId = job.task_id) => {
    useBackofficeWorkFocus.getState().focus({ scope, taskId })
    useAppStore.getState().openTaskPage({ taskSource: 'backoffice' })
  }
  const load = async () => {
    if (!hasResult || !receipt || loading) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      const received = workflowData(
        await consoleWorkflowApi().readJobResults({ jobId: job.id, attempt: receipt.attempt })
      )
      if (
        received.job_id !== job.id ||
        received.attempt !== receipt.attempt ||
        received.receipt.sha256 !== receipt.sha256 ||
        received.receipt.file_id !== receipt.file_id
      ) {
        throw new Error('The result belongs to a different job attempt. Refresh to continue.')
      }
      if (active.current) {
        setResult(received)
      }
    } catch (failure) {
      if (active.current) {
        setError(workflowErrorMessage(failure))
      }
    } finally {
      if (active.current) {
        setLoading(false)
      }
    }
  }
  const deleted =
    result?.changed_files.filter((path) => !result.files.some((file) => file.path === path)) ?? []
  return (
    <section
      aria-label={translate('consoleWorkflows.resultAccess', 'Results')}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {BOARD_TASK_ID_PATTERN.test(job.task_id) && (
          <Button size="sm" variant="outline" onClick={() => openTask()}>
            {translate('consoleWorkflows.openResultTask', 'Open task')}
          </Button>
        )}
        {hasResult && !result && (
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            {translate('consoleWorkflows.openResultFiles', 'Open result files')}
          </Button>
        )}
        {deliveredThread && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setThreadOpen((value) => !value)}
            aria-expanded={threadOpen}
          >
            {translate('consoleWorkflows.openDeliveredRequest', 'Open delivered handoff')}
          </Button>
        )}
      </div>
      <WorkflowError message={error} />
      {!deliveredThread && job.policy.person_handoff_status && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('consoleWorkflows.handoffNotDelivered', 'Handoff not delivered')}:{' '}
          {job.policy.person_handoff_status.message}
        </p>
      )}
      {result && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <h3 className="text-sm font-medium">
            {translate('consoleWorkflows.finalResponse', 'Final response')}
          </h3>
          <pre className="scrollbar-sleek max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
            {result.response}
          </pre>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              downloadWorkflowExport(result.response, 'text', `${job.id}-response.txt`)
            }
          >
            {translate('consoleWorkflows.saveResponse', 'Download response')}
          </Button>
          <h3 className="text-sm font-medium">
            {translate('consoleWorkflows.resultFiles', 'Files in this result')}
          </h3>
          {result.files.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {translate('consoleWorkflows.noResultFiles', 'This result contains no files.')}
            </p>
          )}
          <ul className="scrollbar-sleek max-h-80 space-y-1 overflow-auto">
            {result.files.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-2">
                <span className="break-all font-mono text-xs">{file.path}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    downloadExactHandoffFile({
                      name: file.path.split('/').at(-1)!,
                      sha256: file.sha256,
                      size: file.size_bytes,
                      contentBase64: file.content_b64
                    })
                  }
                  aria-label={`${translate('consoleWorkflows.downloadResultFile', 'Download')} ${file.path}`}
                >
                  {translate('consoleWorkflows.downloadResultFile', 'Download')}
                </Button>
              </li>
            ))}
          </ul>
          {deleted.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {translate('consoleWorkflows.deletedResultFiles', 'Deleted files')}:{' '}
              {deleted.join(', ')}
            </p>
          )}
        </div>
      )}
      {threadOpen && deliveredThread && (
        <HandoffDetailView
          key={deliveredThread}
          scope={scope}
          threadId={deliveredThread}
          onOpenTask={openTask}
        />
      )}
    </section>
  )
}
