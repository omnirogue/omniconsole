import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { translate } from '@/i18n/i18n'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { openHandoffReviewSession } from './handoff-review-launch'

export function HandoffSessionButton({
  detail,
  mode,
  disabled = false
}: {
  detail: HandoffDetail
  mode: 'edit' | 'continue'
  disabled?: boolean
}) {
  const [destination, setDestination] = useState<'folder' | 'worktree'>('folder')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const start = async () => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    try {
      setError(await openHandoffReviewSession(detail, mode, destination))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  // Why: one verb everywhere the recipient can launch a session; the tooltip/aria name stays distinct.
  const tooltip = translate('handoffs.startWithMyAi', 'Start with my AI')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={mode === 'edit' ? 'outline' : 'default'}
          disabled={disabled || pending}
          title={tooltip}
          aria-label={tooltip}
          onClick={() => void start()}
        >
          {translate('handoffs.continueWithAi', 'Continue with AI')}
        </Button>
        <Select
          value={destination}
          onValueChange={(value) => setDestination(value === 'worktree' ? 'worktree' : 'folder')}
          disabled={disabled || pending}
        >
          <SelectTrigger
            size="sm"
            aria-label={translate('handoffs.sessionLocation', 'Session location')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="folder">{translate('handoffs.inFolder', 'In a folder')}</SelectItem>
            <SelectItem value="worktree">
              {translate('handoffs.inWorktree', 'In a new worktree…')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <WorkflowError message={error} />
    </div>
  )
}
