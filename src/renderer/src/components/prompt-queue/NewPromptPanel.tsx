import { useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { usePromptQueue } from './use-prompt-queue'

/** Measured to be worth one click: a finished agent almost always improves on it. */
export const PROMPT_QUEUE_CHIPS = ['bestJob', 'continue'] as const

function chipText(chip: (typeof PROMPT_QUEUE_CHIPS)[number]): string {
  return chip === 'bestJob'
    ? translate('promptQueue.chipBestJob', 'Have you done your best job?')
    : translate('promptQueue.chipContinue', 'Continue')
}

/**
 * Type the next prompt now; it is sent when this agent finishes.
 *
 * Enter queues, Shift+Enter makes a new line, Escape closes. Nothing else: this is
 * the message the person would otherwise have typed themselves.
 */
export function NewPromptPanel({
  source,
  onClose
}: {
  source: ConversationSource
  onClose: () => void
}) {
  const { enqueue, error } = usePromptQueue(source)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const queue = async (value: string): Promise<void> => {
    if (!value.trim() || busy) {
      return
    }
    setBusy(true)
    try {
      await enqueue(value)
      setText('')
      onClose()
    } catch {
      // The hook keeps the reason; the panel stays open so the text is not lost.
    } finally {
      setBusy(false)
    }
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void queue(text)
    }
  }
  return (
    <div className="w-64 space-y-2 p-2" data-prompt-queue-panel>
      <p className="text-xs font-medium">{translate('promptQueue.newPrompt', 'New prompt')}</p>
      <p className="text-muted-foreground text-xs">
        {translate(
          'promptQueue.newPromptHint',
          'Queue a prompt for this agent — sent when it finishes'
        )}
      </p>
      <Textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={keyDown}
        aria-label={translate('promptQueue.newPrompt', 'New prompt')}
        placeholder={translate('promptQueue.newPromptPlaceholder', 'Type the next prompt…')}
        className="text-xs"
      />
      <div className="flex flex-wrap gap-1">
        {PROMPT_QUEUE_CHIPS.map((chip) => (
          <Button
            key={chip}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto px-2 py-1 text-xs"
            disabled={busy}
            onClick={() => void queue(chipText(chip))}
          >
            {chipText(chip)}
          </Button>
        ))}
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  )
}
