import { translate } from '@/i18n/i18n'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { invalidateBackofficeWork } from './backoffice-work-store'
export function BackofficeTaskBlock({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const prepare = async () => {
    setOpen(true)
    setRevision(null)
    try {
      const task = workflowData(await consoleWorkflowApi().getTask({ taskId }))
      setRevision(task.state_revision ?? null)
    } catch (failure) {
      setError(workflowErrorMessage(failure))
    }
  }
  const block = async () => {
    if (busy.current || revision === null || !reason.trim()) {
      return
    }
    busy.current = true
    setPending(true)
    try {
      workflowData(
        await consoleWorkflowApi().updateTask({
          taskId,
          expectedRevision: revision,
          blockedReason: reason.trim()
        })
      )
      setOpen(false)
      setReason('')
      invalidateBackofficeWork()
    } catch (failure) {
      setError(workflowErrorMessage(failure))
      setRevision(null)
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void prepare()}>
        {translate('unifiedWork.18f2a0947f9d', 'Blocked')}
      </Button>
      {open && (
        <>
          <Textarea
            aria-label={translate('unifiedWork.fd9f35d20df3', 'Blocking reason')}
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
            maxLength={8000}
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'unifiedWork.a1b2915b370b',
              'Records a task blocker. Current task permissions and revision apply.'
            )}
          </p>
          <Button
            size="sm"
            disabled={pending || revision === null || !reason.trim()}
            onClick={() => void block()}
          >
            {translate('unifiedWork.6fc4b70a0da1', 'Save blocker')}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
