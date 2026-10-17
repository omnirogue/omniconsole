import { SESSION_PREP_MAX_CONTEXT_CHARS } from './session-prep-types'

export type SessionPrepContextLabel = 'User' | 'Assistant'

function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** One excerpt entry, or null when the message has no text. */
export function formatSessionPrepEntry(
  label: SessionPrepContextLabel,
  text: string
): string | null {
  const body = collapseBlankLines(text)
  // Why indent continuation lines: a role marker may only start a line the person or agent
  // actually began, so text an assistant quotes ("User: …") can never pass as the person's words.
  return body ? `${label}: ${body.replace(/\n/g, '\n  ')}` : null
}

/** Newest whole entries that fit in `max`, oldest first; never splits an entry. */
export function takeNewestFitting(
  entries: string[],
  max: number = SESSION_PREP_MAX_CONTEXT_CHARS
): string {
  const kept: string[] = []
  let size = 0
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    const extra = kept.length > 0 ? 1 : 0
    if (size + extra + entry.length > max) {
      break
    }
    kept.unshift(entry)
    size += extra + entry.length
  }
  return kept.join('\n')
}
