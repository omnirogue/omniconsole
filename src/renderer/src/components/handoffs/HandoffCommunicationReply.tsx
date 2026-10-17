import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { WorkflowError, WorkflowTextField } from '@/components/console-workflows/WorkflowFields'
import { communicationExpectationLabel } from '@/components/native-chat/chat-communication-labels'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { handoffApi } from './handoff-client'
import {
  clearPendingHandoff,
  recoverPendingHandoff,
  retainPendingHandoff,
  isRejectedHandoff
} from './handoff-request-memory'

export function HandoffCommunicationReply({
  scope,
  detail,
  viewer,
  onChanged
}: {
  scope: string
  detail: HandoffDetail
  viewer: string | null
  onChanged: () => void
}) {
  const target = `reply:${detail.thread.id}`
  const [recovery] = useState(() => recoverPendingHandoff(scope, target))
  const [saved, setSaved] = useState(recovery.pending?.kind === 'respond' ? recovery.pending : null)
  const [note, setNote] = useState(saved?.body.note ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(recovery.error)
  const busy = useRef(false)
  const current = () => selectConsoleAccountScope(useAppStore.getState()) === scope
  const type = detail.thread.communication_type
  if (
    detail.thread.state === 'resolved' ||
    !viewer ||
    ![detail.thread.author_employee_id, detail.thread.recipient_employee_id].includes(viewer)
  ) {
    return null
  }

  const submit = async (kind: 'reply' | 'done') => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    try {
      if (!current()) {
        throw new Error('Your account changed. Reopen this message before replying.')
      }
      const intent = saved ?? {
        kind: 'respond' as const,
        body: {
          threadId: detail.thread.id,
          kind,
          note: note.trim() || translate('handoffs.markedComplete', 'Marked complete.'),
          operationId: crypto.randomUUID()
        }
      }
      retainPendingHandoff(scope, target, intent)
      setSaved(intent)
      workflowData(await handoffApi().respond(intent.body))
      clearPendingHandoff(scope, target, intent.body.operationId)
      if (current()) {
        setSaved(null)
        setNote('')
        onChanged()
      }
    } catch (reason) {
      if (isRejectedHandoff(reason)) {
        const retained = recoverPendingHandoff(scope, target).pending
        if (retained) {
          clearPendingHandoff(scope, target, retained.body.operationId)
        }
        if (current()) {
          setSaved(null)
        }
      }
      if (current()) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      busy.current = false
      if (current()) {
        setPending(false)
      }
    }
  }
  return (
    <div className="space-y-2" data-handoff-communication-reply>
      {type && (
        <p className="text-xs text-muted-foreground">{communicationExpectationLabel(type)}</p>
      )}
      <WorkflowTextField
        label={translate('chatDelivery.reply', 'Reply')}
        value={note}
        onChange={setNote}
        multiline
        prose
        maxLength={8192}
        disabled={pending || !!saved}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={pending || !!recovery.error || (!saved && !note.trim())}
          onClick={() => void submit('reply')}
        >
          {saved
            ? translate('handoffs.retrySavedAction9b513', 'Retry saved action')
            : translate('chatDelivery.reply', 'Reply')}
        </Button>
        {type && !saved && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !!recovery.error}
            onClick={() => void submit('done')}
          >
            {translate('chatActions.complete', 'Complete')}
          </Button>
        )}
      </div>
      <WorkflowError message={error} />
    </div>
  )
}
