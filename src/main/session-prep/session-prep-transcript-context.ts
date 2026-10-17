import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { formatSessionPrepEntry, takeNewestFitting } from '../../shared/session-prep-context-format'
import { SESSION_PREP_MAX_CONTEXT_CHARS } from '../../shared/session-prep-types'

// Why the tail only: a long Claude transcript runs to many MB; the excerpt keeps ≤24k chars anyway.
const TRANSCRIPT_TAIL_BYTES = 1_048_576
// Why: harness wrappers (reminders, command echoes, hook output) are not the person's words.
const HARNESS_TEXT =
  /^<(system-reminder|command-|local-command-|bash-|task-notification|user-prompt-submit-hook)/

type TranscriptRow = {
  type?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  message?: { role?: unknown; content?: unknown }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
    .join('\n')
}

function transcriptEntry(row: TranscriptRow): string | null {
  const role = row.message?.role
  if (row.isMeta === true || row.isSidechain === true || row.type !== role) {
    return null
  }
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const text = messageText(row.message?.content).trim()
  if (!text || (role === 'user' && HARNESS_TEXT.test(text))) {
    return null
  }
  return formatSessionPrepEntry(role === 'user' ? 'User' : 'Assistant', text)
}

/** The conversation excerpt session prep plans from, built from a Claude transcript (JSONL). */
export function claudeTranscriptContext(
  raw: string,
  max: number = SESSION_PREP_MAX_CONTEXT_CHARS
): string {
  const entries: string[] = []
  for (const line of raw.split('\n')) {
    let row: TranscriptRow
    try {
      row = JSON.parse(line) as TranscriptRow
    } catch {
      // Why: the tail's first line is usually cut mid-record.
      continue
    }
    const entry = row && typeof row === 'object' ? transcriptEntry(row) : null
    if (entry) {
      entries.push(entry)
    }
  }
  return takeNewestFitting(entries, max)
}

export async function readClaudeTranscriptContext(path: string): Promise<string> {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) {
    return ''
  }
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    return claudeTranscriptContext(buffer.toString('utf8'))
  } finally {
    await handle.close()
  }
}
