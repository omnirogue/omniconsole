import { Button } from '@/components/ui/button'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { translate } from '@/i18n/i18n'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { useHandoffTransfer } from './useHandoffTransfer'
import { HandoffSessionButton } from './HandoffSessionButton'

export function HandoffTransferBar({
  scope,
  detail,
  onReply
}: {
  scope: string
  detail: HandoffDetail
  onChanged: () => void
  onReply: () => void
}) {
  const action = useHandoffTransfer(scope, detail.thread.id)
  const disabled = action.pending || action.blocked
  const retained = !!action.saved.save
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <HandoffSessionButton detail={detail} mode="continue" disabled={disabled || retained} />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void action.perform('save')}
        >
          {action.saved.save
            ? translate('handoffs.retrySaveFiles', 'Retry saving files')
            : translate('handoffs.saveFiles', 'Save files…')}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || retained} onClick={onReply}>
          {translate('handoffs.reply', 'Reply')}
        </Button>
      </div>
      <WorkflowError message={action.error} />
      {action.message && (
        <p role="status" className="text-sm">
          {action.message}
        </p>
      )}
    </section>
  )
}
