import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CAPACITY_RECOVERY_ENTRY_PREFIX } from '../../../../shared/conversation-capacity-recovery'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { isPromptQueueEntrySettled } from '../../../../shared/prompt-queue-types'
import { promptQueueCommandHint } from './prompt-queue-command-runner'
import { usePromptQueue } from './use-prompt-queue'
import { CapacityRecoveryNotice } from './CapacityRecoveryNotice'
import { promptQueueEntryLabel as promptLabel } from './prompt-queue-entry-label'
import { PromptQueueFailedEntry } from './PromptQueueFailedEntry'

/**
 * What is waiting, in order — `Queued 2 · Plan · Have you done your best job?`.
 *
 * Absent when nothing is queued and nothing failed. It shows the person's own
 * words, their order, and the one thing they cannot see otherwise: that a prompt
 * could not be delivered — and, when it was theirs, that the queue waits behind it.
 */
export function PromptQueueStrip({ source }: { source: ConversationSource | null }) {
  const { queue, waitReason, remove, reorder, requeue, clearDelivered, error } =
    usePromptQueue(source)
  const humanEntries = queue.entries.filter(
    (entry) => !entry.id.startsWith(CAPACITY_RECOVERY_ENTRY_PREFIX)
  )
  const waiting = humanEntries.filter((entry) => entry.state === 'queued')
  const sending = humanEntries.find((entry) => entry.state === 'sending') ?? null
  const failed = humanEntries.filter((entry) => entry.state === 'failed')
  const pausedBy = waitReason?.kind === 'paused-after-failure' ? waitReason.entryId : null
  if (!source || (!queue.recovery && !waiting.length && !sending && !failed.length)) {
    return null
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5 text-xs"
      data-prompt-queue-strip
    >
      {queue.recovery ? (
        <CapacityRecoveryNotice recovery={queue.recovery} worktreeId={source.worktreeId} />
      ) : null}
      {/* First: a pause is why everything after it is not moving. */}
      {failed.map((entry) => (
        <PromptQueueFailedEntry
          key={entry.id}
          entry={entry}
          paused={entry.id === pausedBy}
          onRequeue={() => void requeue(entry.id)}
          onDismiss={() => void remove(entry.id)}
        />
      ))}
      {waiting.length ? (
        <span className="text-muted-foreground font-medium" title={promptQueueCommandHint()}>
          {translate('promptQueue.queuedCount', 'Queued {{count}}', { count: waiting.length })}
        </span>
      ) : null}
      {waiting.map((entry, index) => (
        <span
          key={entry.id}
          className="flex items-center gap-0.5"
          data-prompt-queue-entry={entry.id}
        >
          <span className="max-w-64 truncate">{promptLabel(entry)}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-5 p-0"
            disabled={index === 0}
            aria-label={translate('promptQueue.moveUp', 'Move earlier')}
            onClick={() => void reorder(entry.id, 'up')}
          >
            <ChevronUp className="size-3" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-5 p-0"
            disabled={index === waiting.length - 1}
            aria-label={translate('promptQueue.moveDown', 'Move later')}
            onClick={() => void reorder(entry.id, 'down')}
          >
            <ChevronDown className="size-3" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="size-5 p-0"
            aria-label={translate('promptQueue.removeEntry', 'Remove this queued prompt')}
            onClick={() => void remove(entry.id)}
          >
            <X className="size-3" aria-hidden />
          </Button>
        </span>
      ))}
      {sending ? (
        <span className="text-muted-foreground" data-prompt-queue-sending>
          {translate('promptQueue.sending', 'Sending…')}
        </span>
      ) : null}
      {humanEntries.some(isPromptQueueEntrySettled) ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 px-1 text-xs"
          onClick={() => void clearDelivered()}
        >
          {translate('promptQueue.clearDelivered', 'Clear')}
        </Button>
      ) : null}
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  )
}
