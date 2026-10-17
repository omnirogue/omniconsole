import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
export function BackofficeSessionLink({
  sessionId,
  taskId,
  onLinked
}: {
  sessionId: string
  taskId: string
  onLinked: () => void
}) {
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    try {
      workflowData(await consoleWorkflowApi().attachWorkSession({ sessionId, taskId }))
      onLinked()
    } catch (failure) {
      setError(workflowErrorMessage(failure))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || !/^ses_[A-Za-z0-9_-]+$/.test(sessionId)}
        onClick={() => void link()}
      >
        {translate('unifiedWork.linkSession', 'Link this session to this task')}
      </Button>
      <p className="font-mono text-xs">{taskId}</p>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
