import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { asRecord } from '../ai-vault/session-scanner-record-value'

type FinalTurnInput = {
  agent: 'claude' | 'codex'
  sessionId: string
  startedAt: number
  completedAt: number
}

type FinalTurn = { content: string; completedAt: number }
type TranscriptRecord = Record<string, unknown>
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024

function timestamp(record: TranscriptRecord): number {
  return typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
}

function failed(record: TranscriptRecord): boolean {
  return (
    record.isApiErrorMessage === true ||
    record.is_error === true ||
    record.apiErrorStatus != null ||
    (record.error != null && record.error !== false) ||
    (Array.isArray(record.errors) && record.errors.length > 0) ||
    record.model === '<synthetic>' ||
    ['error', 'turn_aborted', 'task_aborted', 'task_failed', 'turn_failed'].includes(
      String(record.type)
    )
  )
}

function sessionMatches(record: TranscriptRecord, input: FinalTurnInput): boolean {
  const payload = asRecord(record.payload)
  const ids = [record, payload].flatMap((value) =>
    ['sessionId', 'session_id', 'thread_id'].map((key) => value?.[key])
  )
  if (record.type === 'session_meta') {
    ids.push(payload?.id ?? null)
  }
  return ids.every((id) => id === undefined || id === input.sessionId)
}

function preStartBoundary(record: TranscriptRecord, input: FinalTurnInput): boolean {
  const body = asRecord(input.agent === 'claude' ? record.message : record.payload) ?? {}
  return input.agent === 'claude'
    ? record.type === 'user' &&
        record.isMeta !== true &&
        record.isCompactSummary !== true &&
        !failed(record) &&
        !failed(body) &&
        userPrompt(body)
    : record.type === 'event_msg' &&
        body.type === 'task_started' &&
        typeof body.turn_id === 'string' &&
        Boolean(body.turn_id)
}

function parseRecords(
  text: string,
  input: FinalTurnInput,
  truncated = false
): TranscriptRecord[] | null {
  if (
    !input.sessionId.trim() ||
    !Number.isFinite(input.startedAt) ||
    !Number.isFinite(input.completedAt) ||
    input.startedAt <= 0 ||
    input.completedAt < input.startedAt ||
    Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES ||
    !text.endsWith('\n')
  ) {
    return null
  }
  const records: TranscriptRecord[] = []
  let anchored = !truncated
  let previousTime = input.startedAt
  try {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue
      }
      const record = asRecord(JSON.parse(line) as unknown)
      if (!record || !sessionMatches(record, input)) {
        return null
      }
      if (
        input.agent === 'claude' &&
        (record.isSidechain === true || record.parent_tool_use_id != null)
      ) {
        continue
      }
      const body = asRecord(input.agent === 'claude' ? record.message : record.payload) ?? {}
      const types =
        input.agent === 'claude'
          ? ['user', 'assistant']
          : ['event_msg', 'response_item', 'turn_context']
      const time = timestamp(record)
      if (
        !Number.isFinite(time) &&
        (types.includes(String(record.type)) || failed(record) || failed(body))
      ) {
        return null
      }
      if (!anchored && Number.isFinite(time)) {
        if (time >= input.startedAt) {
          return null
        }
        anchored = preStartBoundary(record, input)
      }
      if (!Number.isFinite(time) || time < input.startedAt || time > input.completedAt) {
        continue
      }
      if (time < previousTime) {
        return null
      }
      previousTime = time
      records.push(record)
    }
  } catch {
    return null
  }
  return anchored ? records : null
}

function textContent(message: TranscriptRecord): string | null {
  const parts = Array.isArray(message.content) ? message.content.map(asRecord) : []
  if (
    parts.some(
      (part) => !part || !['text', 'thinking', 'redacted_thinking'].includes(String(part.type))
    )
  ) {
    return null
  }
  const texts = parts.filter((part) => part?.type === 'text')
  if (texts.some((part) => typeof part?.text !== 'string')) {
    return null
  }
  const content = texts.map((part) => part!.text).join('\n')
  return content.trim() ? content : null
}

function toolResult(message: TranscriptRecord): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((part) => asRecord(part)?.type === 'tool_result')
  )
}

function userPrompt(message: TranscriptRecord): boolean {
  if (typeof message.content === 'string') {
    return Boolean(message.content.trim())
  }
  return (
    Array.isArray(message.content) &&
    message.content
      .map(asRecord)
      .some(
        (part) =>
          ['text', 'input_text'].includes(String(part?.type)) &&
          typeof part?.text === 'string' &&
          Boolean(part.text.trim())
      )
  )
}

function claudeFinal(records: TranscriptRecord[]): FinalTurn | null {
  let current = false
  let result: FinalTurn | null = null
  for (const record of records) {
    const message = asRecord(record.message) ?? {}
    if (failed(record) || failed(message)) {
      return null
    }
    if (record.type === 'user' && !toolResult(message)) {
      if (current) {
        return result
      }
      if (record.isMeta === true || record.isCompactSummary === true || !userPrompt(message)) {
        return null
      }
      current = true
      continue
    }
    if (!current) {
      if (record.type === 'user' || record.type === 'assistant') {
        return null
      }
      continue
    }
    if (record.type !== 'assistant') {
      continue
    }
    result = null
    if (!['end_turn', 'stop_sequence'].includes(String(message.stop_reason))) {
      continue
    }
    const content = textContent(message)
    result = content ? { content, completedAt: timestamp(record) } : null
  }
  return result
}

function codexFinal(records: TranscriptRecord[]): FinalTurn | null {
  let turn: string | null = null
  let hasUser = false
  let result: FinalTurn | null = null
  for (const record of records) {
    const payload = asRecord(record.payload) ?? {}
    if (failed(record) || failed(payload)) {
      return null
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      if (turn) {
        return result
      }
      if (typeof payload.turn_id !== 'string' || !payload.turn_id) {
        return null
      }
      turn = payload.turn_id
      continue
    }
    if (!turn) {
      if (['event_msg', 'response_item', 'turn_context'].includes(String(record.type))) {
        return null
      }
      continue
    }
    if (payload.turn_id != null && payload.turn_id !== turn) {
      return null
    }
    if (
      (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') ||
      (record.type === 'event_msg' && payload.type === 'user_message')
    ) {
      if (result) {
        return result
      }
      if (
        record.type === 'response_item'
          ? !userPrompt(payload)
          : typeof payload.message !== 'string' || !payload.message.trim()
      ) {
        return null
      }
      hasUser = true
    }
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      if (
        !hasUser ||
        payload.turn_id !== turn ||
        result ||
        typeof payload.last_agent_message !== 'string' ||
        !payload.last_agent_message.trim()
      ) {
        return null
      }
      result = { content: payload.last_agent_message, completedAt: timestamp(record) }
    }
  }
  return result
}

/** The first native turn started inside this run; no screen text or previous-turn fallback. */
export function parseAutomationFinalTurn(text: string, input: FinalTurnInput): FinalTurn | null {
  const records = parseRecords(text, input)
  const parse = input.agent === 'claude' ? claudeFinal : codexFinal
  return records ? parse(records) : null
}

/** Caller supplies the immutable native-hook path, never a renderer-selected transcript. */
export function readAutomationFinalTurn(
  input: FinalTurnInput & { transcriptPath: string }
): FinalTurn | null {
  let descriptor: number | undefined
  try {
    descriptor = openSync(input.transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = fstatSync(descriptor)
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) {
      return null
    }
    const length = Math.min(before.size, MAX_TRANSCRIPT_BYTES)
    const start = before.size - length
    const buffer = Buffer.allocUnsafe(length)
    if (readSync(descriptor, buffer, 0, length, start) !== length) {
      return null
    }
    const after = fstatSync(descriptor)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return null
    }
    // A bounded tail may begin inside JSON or a UTF-8 code point.
    const newline = start > 0 ? buffer.indexOf(10) : -1
    if (start > 0 && newline < 0) {
      return null
    }
    const records = parseRecords(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(newline + 1)),
      input,
      start > 0
    )
    const parse = input.agent === 'claude' ? claudeFinal : codexFinal
    return records ? parse(records) : null
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /* Unreadable transcripts prove nothing. */
      }
    }
  }
}
