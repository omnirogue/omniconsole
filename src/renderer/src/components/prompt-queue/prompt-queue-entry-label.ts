import type { PromptQueueEntry } from '../../../../shared/prompt-queue-types'

/** One line of the prompt's own text, never a summary of it. */
export function promptQueueEntryLabel(entry: Pick<PromptQueueEntry, 'text'>): string {
  const line = entry.text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}
