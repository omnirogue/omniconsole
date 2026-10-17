import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { WorkflowError, WorkflowTextField } from '@/components/console-workflows/WorkflowFields'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { useHandoffDecision } from './useHandoffDecision'
import { HandoffSessionButton } from './HandoffSessionButton'
import { HandoffTransferBar } from './HandoffTransferBar'
import { handoffDecision, isHandoffReview } from './handoff-review-decision'

export function HandoffDecisionStatus({ detail }: { detail: HandoffDetail }) {
  const decision = handoffDecision(detail)
  if (!decision) {
    return null
  }
  return (
    <p role="status" className="text-sm">
      {decision === 'approve'
        ? translate('handoffs.decisionLooksGood', 'You said: looks good')
        : translate('handoffs.decisionNeedsChanges', 'You asked for changes')}
    </p>
  )
}

export function HandoffDecisionBar(props: {
  scope: string
  detail: HandoffDetail
  onChanged: () => void
  onReply?: () => void
}) {
  return isHandoffReview(props.detail) ? (
    <HandoffReviewBar {...props} />
  ) : (
    <HandoffTransferBar {...props} onReply={props.onReply ?? (() => {})} />
  )
}

function HandoffReviewBar({
  scope,
  detail,
  onChanged
}: {
  scope: string
  detail: HandoffDetail
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'request_changes' | null>(null)
  const [note, setNote] = useState('')
  const action = useHandoffDecision(scope, detail, () => {
    setMode(null)
    setNote('')
    onChanged()
  })
  const disabled = action.pending || action.blocked || !!action.saved
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={() => void action.perform('approve', '')}>
          {translate('handoffs.looksGoodContinue', 'Looks good, continue')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setMode('request_changes')}
        >
          {translate('handoffs.needsChanges', 'Needs changes…')}
        </Button>
        <HandoffSessionButton detail={detail} mode="edit" disabled={disabled} />
      </div>
      {mode === 'request_changes' && (
        <>
          <WorkflowTextField
            label={translate('handoffs.requestedEdits0dd01', 'Requested edits')}
            value={note}
            onChange={setNote}
            disabled={disabled}
            multiline
            prose
            maxLength={8182}
          />
          <Button
            size="sm"
            disabled={disabled || !note.trim()}
            onClick={() => void action.perform('request_changes', note)}
          >
            {translate('handoffs.sendDecisiona43a4', 'Send decision')}
          </Button>
        </>
      )}
      {action.saved && (
        <Button
          size="sm"
          disabled={action.pending || action.blocked}
          onClick={() => void action.perform('approve', '')}
        >
          {translate('handoffs.retrySavedAction9b513', 'Retry saved action')}
        </Button>
      )}
      <WorkflowError message={action.error} />
    </section>
  )
}
