import type { NativeChatMessage } from '../../shared/native-chat-types'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { TranscriptPageSource } from './transcript-page-source'

const utf8 = new TextDecoder('utf-8', { fatal: true })

export async function readJsonDocument(
  file: TranscriptPageSource,
  start: number,
  size: number,
  maxPayloadBytes: number,
  signal?: AbortSignal,
  requireMessagesArray = true,
  expectedSessionId?: string
) {
  const parts: Buffer[] = []
  const safeBytes = Math.max(1, Math.floor((maxPayloadBytes - 1024) / 6))
  const smallDocument = size <= safeBytes
  const pageEnd = smallDocument
    ? size
    : Math.min(size, start + Math.min(MAX_FILE_RANGE_READ_BYTES, safeBytes))
  for (let offset = start; offset < pageEnd;) {
    signal?.throwIfAborted()
    const length = Math.min(MAX_FILE_RANGE_READ_BYTES, pageEnd - offset)
    const bytes = await file.read(offset, length)
    if (bytes.length !== length) {
      throw new Error('The JSON transcript changed during capture. Retry on its owning host.')
    }
    parts.push(bytes)
    offset += length
  }
  const { text, byteLength } = decodeJsonPage(Buffer.concat(parts), pageEnd < size)
  // Larger documents are validated after complete assembly by the requesting client.
  if (smallDocument) {
    const document: unknown = JSON.parse(text)
    if (
      !document ||
      typeof document !== 'object' ||
      (requireMessagesArray && !Array.isArray((document as { messages?: unknown }).messages))
    ) {
      throw new Error('The provider JSON source is not a complete conversation document.')
    }
    for (const key of ['sessionId', 'session_id'] as const) {
      const value = (document as Record<string, unknown>)[key]
      if (expectedSessionId && typeof value === 'string' && value.trim() !== expectedSessionId) {
        throw new Error('The provider JSON transcript belongs to a different source session.')
      }
    }
  }
  const sourceRecords = [{ byteOffset: start, text }]
  if (Buffer.byteLength(JSON.stringify(sourceRecords)) > maxPayloadBytes) {
    throw new Error('The JSON transcript exceeds the complete capture payload limit.')
  }
  return {
    messages: [] as NativeChatMessage[],
    sourceRecords,
    nextOffset: start + byteLength,
    droppingOversizedRecord: false,
    malformedRecordCount: 0,
    oversizedRecordCount: 0,
    truncatedRecordCount: 0
  }
}

function decodeJsonPage(bytes: Buffer, hasNextPage: boolean): { text: string; byteLength: number } {
  // A page boundary may bisect one UTF-8 codepoint; interior corruption remains an error.
  for (let omitted = 0; omitted <= (hasNextPage ? 3 : 0); omitted++) {
    try {
      const completeBytes = bytes.subarray(0, bytes.length - omitted)
      return { text: utf8.decode(completeBytes), byteLength: completeBytes.length }
    } catch (error) {
      if (omitted === (hasNextPage ? 3 : 0)) {
        throw error
      }
    }
  }
  throw new Error('The JSON transcript contains invalid UTF-8.')
}
