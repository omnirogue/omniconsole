/**
 * The assistant's final message for the turn a routine run started, read from the Codex
 * rollout JSONL the hook named (`providerSessionTranscriptPath`). The rollout is the
 * message as the model produced it; the pane's screen text is a soft-wrapped redraw of
 * whatever the TUI last showed — on 2026-09-20 that was the PREVIOUS run's report plus
 * a "Conversation interrupted · R to Retry" banner, recorded as a completed apply run.
 */
import { readFileSync } from 'node:fs'

export type CodexRolloutTurnResult = {
  message: string
  completedAt: number
}

/** A rollout grows for the life of the thread; the run's turn is at its end. */
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024

/** Null when the rollout cannot be read: an unreadable transcript proves nothing. */
export function readCodexRolloutTail(path: string): string | null {
  try {
    const buffer = readFileSync(path)
    return buffer.subarray(Math.max(0, buffer.length - ROLLOUT_TAIL_BYTES)).toString('utf8')
  } catch {
    return null
  }
}

/** How far before the run's own start stamp a turn may begin and still be this run's. */
const START_SLACK_MS = 5_000

type RolloutLine = {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    role?: string
    last_agent_message?: unknown
    content?: unknown
  }
}

function lineTime(line: RolloutLine): number {
  const time = line.timestamp ? Date.parse(line.timestamp) : Number.NaN
  return Number.isFinite(time) ? time : Number.NaN
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * The FIRST turn completed at or after `startedAt` — a run is one prompt, one turn, and a
 * person may keep chatting in the same pane afterwards. Its message is
 * `task_complete.last_agent_message` when Codex wrote one, else the last assistant
 * `response_item` before it. Null when the rollout shows no completed turn for this run:
 * the prompt never reached the model.
 */
export function readCodexRolloutTurnResult(
  rollout: string,
  startedAt: number
): CodexRolloutTurnResult | null {
  const earliest = startedAt - START_SLACK_MS
  let lastAssistant: CodexRolloutTurnResult | null = null
  for (const raw of rollout.split('\n')) {
    if (!raw.trim()) {
      continue
    }
    let line: RolloutLine
    try {
      line = JSON.parse(raw) as RolloutLine
    } catch {
      // A tail read can start mid-line; the line before the first full record is noise.
      continue
    }
    const time = lineTime(line)
    if (!Number.isFinite(time) || time < earliest) {
      continue
    }
    const payload = line.payload ?? {}
    if (line.type === 'event_msg' && payload.type === 'task_complete') {
      const message =
        typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : ''
      const text = message || lastAssistant?.message
      return text ? { message: text, completedAt: time } : null
    }
    if (
      line.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant'
    ) {
      const message = assistantText(payload.content)
      if (message) {
        lastAssistant = { message, completedAt: time }
      }
    }
  }
  return null
}
