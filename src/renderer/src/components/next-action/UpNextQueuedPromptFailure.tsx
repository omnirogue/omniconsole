import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { workflowErrorText } from '@/components/local-workflows/workflow-error-text'
import type { UpNextBlock } from '../../../../shared/up-next-types'
import type { UpNextController } from './use-up-next'

/**
 * Why a queued prompt was not delivered, and what the person can do about it. `holdsQueue` comes
 * only from hosts that pause behind a failure and can re-queue it, so an older host never offers
 * "Queue again"; Dismiss is the queue's ordinary remove on every host.
 */
export function UpNextQueuedPromptFailure({
  block,
  controller
}: {
  block: UpNextBlock
  controller: Pick<UpNextController, 'disabled' | 'remove' | 'requeue'>
}) {
  if (block.kind !== 'prompt' || block.state !== 'failed' || !block.queueEntryId) {
    return null
  }
  const requeue = block.holdsQueue ? controller.requeue : undefined
  const reason = block.failureReason ? workflowErrorText(block.failureReason, 'details') : undefined
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-2 text-xs text-destructive"
      data-up-next-prompt-failure={block.id}
      data-up-next-queue-paused={block.holdsQueue || undefined}
    >
      <span className="min-w-0 flex-1 truncate" title={reason}>
        {block.holdsQueue
          ? t(
              'upNext.queuePausedBehind',
              'The queue is paused until you queue this again or dismiss it.'
            )
          : (reason ?? t('upNext.promptNotDelivered', 'This prompt was not delivered.'))}
      </span>
      {requeue ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={controller.disabled}
          onClick={() => void requeue(block.id)}
        >
          {t('upNext.requeuePrompt', 'Queue again')}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={controller.disabled}
        onClick={() => void controller.remove(block.id)}
      >
        {t('upNext.dismissPrompt', 'Dismiss')}
      </Button>
    </div>
  )
}
