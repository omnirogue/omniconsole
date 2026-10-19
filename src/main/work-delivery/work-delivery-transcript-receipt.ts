/**
 * Whether a delivery's own text reached a conversation: it is a user turn (Claude `user` message
 * text, Codex user message) in the transcript, at or after the event. Tool output, assistant text
 * and hook context never count, so a publishing session that ran `work-decision wait`, printed
 * `[choices]` or got a `<peer-message` about the page is not taken for a delivery.
 *
 * Bounded: only the last `tailBytes` of at most `maxFiles` transcripts are read. A delivery older
 * than that window is simply not proven (it stays held), never assumed.
 */

import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ClaimableDelivery } from './work-delivery-kind'

export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
export const TRANSCRIPT_MAX_FILES = 2
/** Long enough to be this decision's text, short enough to survive a capped or wrapped echo. */
const FINGERPRINT_CHARS = 300
const MIN_FINGERPRINT_CHARS = 24
/** A user turn this long before the event is an earlier one, not this delivery. */
const CLOCK_SKEW_MS = 5 * 60_000

export type TranscriptReceiptLimits = { tailBytes: number; maxFiles: number }

const DEFAULT_LIMITS: TranscriptReceiptLimits = {
  tailBytes: TRANSCRIPT_TAIL_BYTES,
  maxFiles: TRANSCRIPT_MAX_FILES
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The part of a delivery's text that must appear in one user turn; null when too short to prove anything. */
export function deliveryFingerprint(text: string): string | null {
  const normalized = normalize(text)
  return normalized.length >= MIN_FINGERPRINT_CHARS ? normalized.slice(0, FINGERPRINT_CHARS) : null
}

/** The last `maxBytes` of a file, starting at its first whole line. */
export async function readTranscriptTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start === 0) {
      return text
    }
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
  } finally {
    await handle.close()
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Text parts of a message; null when any part is a tool result (that is output, not a turn). */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  for (const item of content) {
    const part = asRecord(item)
    if (!part || part.type === 'tool_result' || part.type === 'function_call_output') {
      return null
    }
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/** The text a person or a sender typed as one user turn, with its time; null for any other line. */
export function userTurnText(line: string): { text: string; ts: number | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  const payload = asRecord(record.payload)
  let text: string | null = null
  if (record.type === 'user' && record.isMeta !== true && record.isCompactSummary !== true) {
    text = messageText(asRecord(record.message)?.content)
  } else if (record.type === 'response_item' && payload?.type === 'message') {
    text = payload.role === 'user' ? messageText(payload.content) : null
  } else if (record.type === 'event_msg' && payload?.type === 'user_message') {
    text = typeof payload.message === 'string' ? payload.message : null
  }
  return text ? { text, ts: Number.isFinite(ts) ? ts : null } : null
}

/** Whether the transcript text holds the fingerprint in one user turn at or after `sinceMs`. */
export function transcriptHasUserTurn(
  content: string,
  fingerprint: string,
  sinceMs: number | null
): boolean {
  for (const line of content.split('\n')) {
    // Why the cheap test first: only user lines are parsed.
    if (!line.includes('"user')) {
      continue
    }
    const turn = userTurnText(line)
    // Why an undated turn is skipped: it cannot be shown to follow the event.
    if (!turn || (sinceMs !== null && (turn.ts === null || turn.ts < sinceMs))) {
      continue
    }
    if (normalize(turn.text).includes(fingerprint)) {
      return true
    }
  }
  return false
}

/** Evidence for the audit log when the delivery's text is a user turn in one of the transcripts. */
export async function findDeliveryInTranscripts(
  paths: readonly string[],
  delivery: Pick<ClaimableDelivery, 'text' | 'eventAt' | 'createdAt'>,
  limits: TranscriptReceiptLimits = DEFAULT_LIMITS
): Promise<string | null> {
  const fingerprint = deliveryFingerprint(delivery.text)
  if (!fingerprint) {
    return null
  }
  const event = Date.parse(delivery.eventAt ?? delivery.createdAt ?? '')
  const sinceMs = Number.isFinite(event) ? event - CLOCK_SKEW_MS : null
  for (const path of paths.slice(0, limits.maxFiles)) {
    const content = await readTranscriptTail(path, limits.tailBytes).catch(() => '')
    if (content && transcriptHasUserTurn(content, fingerprint, sinceMs)) {
      return `its text is a user turn in transcript ${basename(path)}`
    }
  }
  return null
}
