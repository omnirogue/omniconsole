// ─── One session → one gate-checked transcript document ─────────────────────
// The assembly `transcripts.buildDeliverable` and the employee transcript
// uploader share: read the session on this host, refuse an oversized source
// on a bounded walk, digest it, render and run the redaction gate. What comes
// out is either a document already proven clean, or a fixed code / a count —
// never an exception message, because a reader error names the transcript
// path and a path is a value.

import { createHash } from 'node:crypto'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { TRANSCRIPT_ERROR_CODES } from '../../shared/conversation-transcript-deliverable'
import { transcriptSourceLength } from '../../shared/transcript-render'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-watch'
import { countProtectedCredentialSites } from './transcript-protected-credentials'
import {
  buildTranscriptDeliverable,
  TranscriptDeliverableError,
  TranscriptTooLargeError,
  type TranscriptDeliverable
} from './transcript-deliverable'

export type SessionTranscriptSource = {
  agent: string
  sessionId: string
  transcriptPath?: string
  /** ISO 8601 capture time; dates the file name and the header. */
  capturedAt: string
  model?: string | null
  /** Newest messages kept when the session is longer than this. */
  limit: number
  /** False renders whole tool payloads (the upload); default clips them (the handoff). */
  clipToolPayloads?: boolean
}

export type SessionTranscriptBuild =
  | {
      kind: 'built'
      deliverable: TranscriptDeliverable
      earlierMessagesOmitted: boolean
      omittedRecords: number
    }
  | { kind: 'refused'; redactions: number }
  | {
      kind: 'error'
      code: (typeof TRANSCRIPT_ERROR_CODES)[keyof typeof TRANSCRIPT_ERROR_CODES]
      sizeBytes?: number
    }

export async function buildSessionTranscript(
  source: SessionTranscriptSource,
  signal?: AbortSignal
): Promise<SessionTranscriptBuild> {
  const read = await readNativeChatTranscriptTail(
    {
      agent: source.agent as AgentType,
      sessionId: source.sessionId,
      ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}),
      limit: source.limit
    },
    signal
  ).catch(() => ({ error: 'contained' }) as const)
  if (!('messages' in read)) {
    return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.unavailable }
  }
  if (!read.messages.length) {
    return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.empty }
  }
  const omittedRecords = (read.malformedRecordCount ?? 0) + (read.oversizedRecordCount ?? 0)
  return buildTranscriptFromMessages(source, read.messages, read.hasMore, omittedRecords)
}

/** The complete and tail readers use the same bounded render and protected-data gate. */
export function buildTranscriptFromMessages(
  source: Omit<SessionTranscriptSource, 'limit'>,
  messages: NativeChatMessage[],
  earlierMessagesOmitted = false,
  omittedRecords = 0
): SessionTranscriptBuild {
  if (!messages.length) {
    return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.empty }
  }
  try {
    // Why first: the size walk enumerates tool-input properties, so a throwing
    // getter would escape here exactly as a serializer fault would. And before
    // anything that copies the whole source — serializing, scanning and rendering
    // each cost a multiple of its size, so an oversized session is refused on a
    // bounded walk rather than after three full passes.
    const size = transcriptSourceLength(messages)
    if (size.overBudget) {
      return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.tooLarge, sizeBytes: size.length }
    }
    // Labeled credentials (a password in a tool input) have no shape for the
    // value redactor to catch once rendered; refuse them on the structure first.
    const labeled = countProtectedCredentialSites(messages)
    if (labeled > 0) {
      return { kind: 'refused', redactions: labeled }
    }
    const sourceDigest = createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    const deliverable = buildTranscriptDeliverable({
      messages,
      agent: source.agent,
      sessionId: source.sessionId,
      capturedAt: source.capturedAt,
      sourceDigest,
      ...(source.model === undefined ? {} : { model: source.model }),
      ...(earlierMessagesOmitted ? { earlierMessagesOmitted: true } : {}),
      ...(omittedRecords ? { omittedRecords } : {}),
      ...(source.clipToolPayloads === undefined
        ? {}
        : { clipToolPayloads: source.clipToolPayloads })
    })
    return { kind: 'built', deliverable, earlierMessagesOmitted, omittedRecords }
  } catch (error) {
    if (error instanceof TranscriptDeliverableError) {
      return { kind: 'refused', redactions: error.redactions }
    }
    if (error instanceof TranscriptTooLargeError) {
      return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.tooLarge, sizeBytes: error.bytes }
    }
    return { kind: 'error', code: TRANSCRIPT_ERROR_CODES.buildFailed }
  }
}
