import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { workflowErrorText } from '@/components/local-workflows/workflow-error-text'
import type { PromptQueueEntry } from '../../../../shared/prompt-queue-types'
import { promptQueueEntryLabel } from './prompt-queue-entry-label'

/**
 * A prompt that could not be delivered, named by its own words with the reason on hover.
 * `paused` when the queue waits behind it; only the person's own prompt can be queued again.
 */
export function PromptQueueFailedEntry({
  entry,
  paused,
  onRequeue,
  onDismiss
}: {
  entry: PromptQueueEntry
  paused: boolean
  onRequeue: () => void
  onDismiss: () => void
}) {
  const prompt = promptQueueEntryLabel(entry)
  return (
    <span
      className="flex items-center gap-0.5 text-destructive"
      data-prompt-queue-failed={entry.id}
      data-prompt-queue-paused={paused || undefined}
    >
      <span
        className="max-w-72 truncate"
        // 'details': a code with no plain words stays itself, since there is no Details here.
        title={entry.reason ? workflowErrorText(entry.reason, 'details') : undefined}
      >
        {paused
          ? translate('promptQueue.pausedAfterFailure', "Paused: '{{prompt}}' failed", { prompt })
          : translate('promptQueue.failedPrompt', "Failed: '{{prompt}}'", { prompt })}
      </span>
      {entry.holdsQueue ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 px-1 text-xs"
          // A send nobody can prove stayed unsent may already be with the agent.
          title={
            entry.unsent
              ? undefined
              : translate('promptQueue.requeueUnconfirmed', 'The agent may already have it.')
          }
          onClick={onRequeue}
        >
          {translate('promptQueue.requeue', 'Queue again')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 px-1 text-xs"
        onClick={onDismiss}
      >
        {translate('promptQueue.dismiss', 'Dismiss')}
      </Button>
    </span>
  )
}
