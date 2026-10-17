import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Bounds one read; a question asked further back than this keeps whatever answered it earlier. */
const MAX_READ_BYTES = 2 * 1024 * 1024
const NEWLINE = 0x0a

function userTextOf(record: unknown): string | null {
  const payload = (record as { type?: unknown; payload?: Record<string, unknown> } | null)?.payload
  if (!payload) {
    return null
  }
  if (payload.type === 'user_message' && typeof payload.message === 'string') {
    return payload.message
  }
  if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    const text = payload.content
      .map((part) => (part as { text?: unknown } | null)?.text)
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
    return text || null
  }
  return null
}

/** How far the rollout has been written: anything written from now on starts at or after it. */
export function codexTranscriptSize(transcriptPath: string): number | null {
  try {
    return statSync(transcriptPath).size
  } catch {
    return null
  }
}

/**
 * The user messages a Codex rollout gained from byte `fromOffset` on, oldest first, each with the
 * offset its line starts at. Why: Codex's own ⌥+↑ answer reaches the model as a user message;
 * reading it here keeps an answered question from coming back when the turn ends, whether or not
 * a hook reported that message.
 */
export function readCodexUserMessagesSince(
  transcriptPath: string,
  fromOffset: number
): { text: string; offset: number }[] {
  let fd: number | null = null
  try {
    const size = statSync(transcriptPath).size
    // Why nothing: a rollout shorter than the mark is not the file the question was asked in.
    if (size <= fromOffset) {
      return []
    }
    const start = Math.max(fromOffset, size - MAX_READ_BYTES)
    const buffer = Buffer.alloc(size - start)
    fd = openSync(transcriptPath, 'r')
    const read = readSync(fd, buffer, 0, buffer.length, start)
    const messages: { text: string; offset: number }[] = []
    // Why skip the first line of a capped read: it starts mid-line. A line cut at the mark itself
    // was being written when the question was asked; it fails to parse and is skipped below.
    let lineStart = start > fromOffset ? buffer.indexOf(NEWLINE) + 1 : 0
    if (lineStart === 0 && start > fromOffset) {
      return []
    }
    while (lineStart < read) {
      const newline = buffer.indexOf(NEWLINE, lineStart)
      const end = newline === -1 || newline > read ? read : newline
      const line = buffer.toString('utf8', lineStart, end)
      // Why the cheap test first: most rollout lines are tool output, never a user message.
      if (line.includes('"user_message"') || line.includes('"user"')) {
        try {
          const text = userTextOf(JSON.parse(line))
          if (text) {
            messages.push({ text, offset: start + lineStart })
          }
        } catch {
          // Why skip: a line being written as we read is incomplete.
        }
      }
      lineStart = end + 1
    }
    return messages
  } catch {
    return []
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}
