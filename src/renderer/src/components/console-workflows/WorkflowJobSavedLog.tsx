import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { ConsoleJobLog } from '../../../../shared/console-job-evidence'
import { WorkflowError } from './WorkflowFields'

/** Older runners publish only a bounded output log when their attempt finishes. */
export function WorkflowJobSavedLog({ jobId, attempt }: { jobId: string; attempt?: number }) {
  const [log, setLog] = useState<ConsoleJobLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={async () => {
          setLoading(true)
          setError(null)
          try {
            const api = consoleWorkflowApi()
            if (typeof api.readJobLog !== 'function') {
              throw new Error('Saved output is unavailable in this IDE version.')
            }
            const received = workflowData(await api.readJobLog({ jobId, attempt }))
            if (
              received.job_id !== jobId ||
              (attempt !== undefined && received.attempt !== attempt)
            ) {
              throw new Error('The server returned output for a different job attempt.')
            }
            setLog(received)
          } catch (failure) {
            setError(workflowErrorMessage(failure))
          } finally {
            setLoading(false)
          }
        }}
      >
        {translate('consoleWorkflows.readSavedOutput', 'Read saved output')}
      </Button>
      <WorkflowError message={error} />
      {log && (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'consoleWorkflows.savedOutputLimit',
              'Saved output from an older runner; at most the last 262,144 characters. It is not a full session transcript.'
            )}
          </p>
          <pre
            aria-label={translate('consoleWorkflows.savedOutput', 'Saved output')}
            className="scrollbar-sleek max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-xs"
          >
            {log.log}
          </pre>
        </>
      )}
    </div>
  )
}
