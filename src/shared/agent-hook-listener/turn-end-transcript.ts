/** The assistant text of a transcript's current turn, read at Stop for turn-end-question.ts. */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { parseAgentHookJson } from './request-body'

/** Bounds the Stop-time read; a turn longer than this keeps only its latest text. */
const TURN_TAIL_BYTES = 256 * 1024

type Json = Record<string, unknown>
const BOUNDARY = Symbol('turn-boundary')
type TurnEntry = typeof BOUNDARY | string | null

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

function readTailLines(path: string, maxBytes: number): string[] {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    if (size <= 0) {
      return []
    }
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    fd = openSync(path, 'r')
    const read = readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8', 0, read).split('\n')
    // Why drop the first: a capped read starts mid-line.
    return start > 0 ? lines.slice(1) : lines
  } catch {
    return []
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

function partsText(content: unknown, types: readonly string[]): string {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(asRecord)
    .filter((part) => part && types.includes(String(part.type)) && typeof part.text === 'string')
    .map((part) => (part!.text as string).trim())
    .filter(Boolean)
    .join('\n')
}

/** Codex rollout lines: a new task or a user message starts the turn; agent messages are its text. */
function codexEntry(type: unknown, payload: Json): TurnEntry {
  if (type === 'event_msg') {
    if (payload.type === 'task_started' || payload.type === 'user_message') {
      return BOUNDARY
    }
    return payload.type === 'agent_message' &&
      typeof payload.message === 'string' &&
      userFacing(payload)
      ? payload.message.trim() || null
      : null
  }
  if (type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return userFacing(payload) ? partsText(payload.content, ['output_text', 'text']) || null : null
  }
  return null
}

const USER_FACING = new Set(['final', 'final_answer', 'commentary'])

/** Codex marks a message's `phase` (older builds: `channel`); unmarked records predate both and count. */
function userFacing(payload: Json): boolean {
  return [payload.phase, payload.channel].every(
    (mark) =>
      mark === undefined || mark === null || (typeof mark === 'string' && USER_FACING.has(mark))
  )
}

/** Claude (and Claude-shaped) lines: a person's prompt starts the turn; tool results and meta do not. */
function claudeEntry(record: Json): TurnEntry {
  if (record.isSidechain === true || record.parent_tool_use_id != null) {
    return null
  }
  const message = asRecord(record.message) ?? record
  const role = record.type === 'user' || record.type === 'assistant' ? record.type : message.role
  if (role === 'assistant') {
    return partsText(message.content, ['text']) || null
  }
  if (role !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
    return null
  }
  // Why any tool_result: hook feedback can ride a tool result as a text part; the turn goes on.
  const toolResult =
    Array.isArray(message.content) &&
    message.content.some((part) => asRecord(part)?.type === 'tool_result')
  return !toolResult && partsText(message.content, ['text', 'input_text']) ? BOUNDARY : null
}

function turnEntryOf(line: string): TurnEntry {
  // Why the cheap test first: most transcript lines are tool traffic.
  if (!/"(?:user|assistant|user_message|agent_message|task_started)"/.test(line)) {
    return null
  }
  let record: Json | null
  try {
    record = asRecord(parseAgentHookJson(line))
  } catch {
    return null
  }
  if (!record) {
    return null
  }
  const payload = asRecord(record.payload)
  return payload && (record.type === 'event_msg' || record.type === 'response_item')
    ? codexEntry(record.type, payload)
    : claudeEntry(record)
}

/** The assistant text of the transcript's current turn (after its last person prompt), oldest first. */
export function readCurrentTurnAssistantText(
  transcriptPath: string | undefined,
  lastAssistantMessage: string | undefined
): string {
  const texts: string[] = []
  const lines = transcriptPath ? readTailLines(transcriptPath, TURN_TAIL_BYTES) : []
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = turnEntryOf(lines[i]!.trim())
    if (entry === BOUNDARY) {
      break
    }
    // Why dedupe: Codex writes each agent message both as an event and as a response item.
    if (entry && !texts.includes(entry)) {
      texts.unshift(entry)
    }
  }
  const last = lastAssistantMessage?.trim()
  // Why: the hook can carry the final message before the transcript has flushed it.
  if (last && !texts.join('\n\n').includes(last)) {
    texts.push(last)
  }
  return texts.join('\n\n')
}
