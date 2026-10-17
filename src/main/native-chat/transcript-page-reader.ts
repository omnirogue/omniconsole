import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  nativeChatLineDecoderForAgent
} from './transcript-tail-reader'
import { transcriptFallbackId } from './transcript-fallback-id'
import { openTranscriptPageSource, type TranscriptPageSource } from './transcript-page-source'
import { readJsonDocument } from './transcript-json-page'

const MAX_PAGE_SCAN_BYTES = 8 * 1024 * 1024
const MAX_PAGE_PAYLOAD_BYTES = 3 * 1024 * 1024
const transcriptUtf8 = new TextDecoder('utf-8', { fatal: true })
export const MAX_TRANSCRIPT_PAGE_RECORDS = 200

export async function readNativeChatTranscriptPage(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptPageResult> {
  return (await import('./transcript-page-dispatch')).dispatchTranscriptPage(args, signal)
}

export async function readTranscriptFilePage(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal,
  options: { maxPayloadBytes?: number } = {}
): Promise<NativeChatTranscriptPageResult> {
  const source = { connectionId: args.connectionId ?? null }
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const exactPath = args.cursor?.filePath ?? args.transcriptPath
  const jsonDocument = exactPath?.endsWith('.json')
  if ((!decode && !exactPath) || (exactPath && !exactPath.endsWith('.jsonl') && !jsonDocument)) {
    return {
      source,
      error: `Complete transcript capture is unavailable for provider ${args.agent}.`
    }
  }
  let file: TranscriptPageSource | null = null
  try {
    const cursor = args.cursor
    if (
      cursor &&
      (cursor.connectionId !== source.connectionId ||
        cursor.agent !== args.agent ||
        cursor.sessionId !== args.sessionId ||
        (args.transcriptPath && cursor.filePath !== args.transcriptPath))
    ) {
      throw new Error('Transcript cursor belongs to a different source session.')
    }
    file = await openTranscriptPageSource(args, signal)
    if (!file) {
      return { source, error: 'Transcript unavailable on its owning host.', notFound: true }
    }
    const stat = await file.stat()
    if (
      cursor &&
      (cursor.sourceEpoch !== file.sourceEpoch ||
        cursor.fileIdentity !== stat.identity ||
        stat.size < cursor.snapshotSize ||
        (stat.size === cursor.observedSize && stat.modifiedAt !== cursor.observedMtime) ||
        (jsonDocument &&
          (stat.size !== cursor.snapshotSize || stat.modifiedAt !== cursor.observedMtime)))
    ) {
      throw new Error('Transcript source changed. Restart capture from the first page.')
    }
    const snapshotSize = cursor?.snapshotSize ?? stat.size
    const startOffset = cursor?.byteOffset ?? 0
    if (
      !Number.isSafeInteger(snapshotSize) ||
      snapshotSize < 0 ||
      !Number.isSafeInteger(startOffset) ||
      startOffset < 0 ||
      startOffset > snapshotSize
    ) {
      throw new Error('Invalid transcript snapshot or cursor offset.')
    }
    const maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAGE_PAYLOAD_BYTES
    const page = jsonDocument
      ? await readJsonDocument(
          file,
          startOffset,
          snapshotSize,
          maxPayloadBytes,
          signal,
          args.agent === 'gemini',
          args.sessionId
        )
      : await scanTranscriptPage(file, {
          startOffset,
          snapshotSize,
          maxPayloadBytes,
          droppingOversizedRecord: cursor?.droppingOversizedRecord ?? false,
          limit: Math.min(
            MAX_TRANSCRIPT_PAGE_RECORDS,
            Math.max(1, args.limit ?? MAX_TRANSCRIPT_PAGE_RECORDS)
          ),
          decode,
          signal
        })
    const after = await file.stat()
    if (
      after.identity !== stat.identity ||
      after.size < snapshotSize ||
      (after.size === stat.size && after.modifiedAt !== stat.modifiedAt) ||
      (jsonDocument && (after.size !== stat.size || after.modifiedAt !== stat.modifiedAt))
    ) {
      throw new Error('Transcript source changed during capture. Retry on its owning host.')
    }
    const complete = page.nextOffset === snapshotSize
    return {
      source,
      messages: page.messages,
      sourceRecords: page.sourceRecords,
      complete,
      malformedRecordCount: page.malformedRecordCount,
      oversizedRecordCount: page.oversizedRecordCount,
      truncatedRecordCount: page.truncatedRecordCount,
      coverage: {
        format: jsonDocument ? 'json' : 'jsonl',
        projection: decode && !jsonDocument ? 'display' : 'raw-only',
        fromByteOffset: startOffset,
        toByteOffset: page.nextOffset,
        snapshotBytes: snapshotSize,
        rawRecords:
          cursor?.droppingOversizedRecord ||
          page.droppingOversizedRecord ||
          page.malformedRecordCount + page.oversizedRecordCount + page.truncatedRecordCount > 0
            ? 'partial'
            : 'complete'
      },
      ...(!complete
        ? {
            cursor: {
              filePath: file.filePath,
              byteOffset: page.nextOffset,
              snapshotSize,
              fileIdentity: stat.identity,
              sourceEpoch: file.sourceEpoch,
              observedSize: after.size,
              observedMtime: after.modifiedAt,
              connectionId: source.connectionId,
              agent: args.agent,
              sessionId: args.sessionId,
              ...(page.droppingOversizedRecord ? { droppingOversizedRecord: true } : {})
            }
          }
        : {})
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return {
      source,
      error: message,
      ...((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { notFound: true as const } : {})
    }
  } finally {
    await file?.close()
  }
}

async function scanTranscriptPage(
  file: TranscriptPageSource,
  args: {
    startOffset: number
    snapshotSize: number
    maxPayloadBytes: number
    droppingOversizedRecord: boolean
    limit: number
    decode: ReturnType<typeof nativeChatLineDecoderForAgent>
    signal?: AbortSignal
  }
) {
  const messages: NativeChatMessage[] = []
  const sourceRecords: { byteOffset: number; text: string }[] = []
  let parts: Buffer[] = []
  let lineBytes = 0
  let droppingOversizedRecord = args.droppingOversizedRecord
  let lineStart = args.startOffset
  let offset = args.startOffset
  let nextOffset = offset
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let truncatedRecordCount = 0
  let payloadBytes = 0
  const scanEnd = Math.min(args.snapshotSize, offset + MAX_PAGE_SCAN_BYTES)
  while (offset < scanEnd) {
    args.signal?.throwIfAborted()
    const length = Math.min(MAX_FILE_RANGE_READ_BYTES, scanEnd - offset)
    const bytes = await file.read(offset, length)
    if (bytes.length !== length) {
      throw new Error('Transcript source shrank during a positional read. Restart capture.')
    }
    let segmentStart = 0
    for (
      let newline = bytes.indexOf(0x0a);
      newline >= 0;
      newline = bytes.indexOf(0x0a, segmentStart)
    ) {
      retain(bytes.subarray(segmentStart, newline))
      const lineEnd = offset + newline + 1
      if (!acceptLine(lineEnd, false)) {
        return result()
      }
      segmentStart = newline + 1
      if (sourceRecords.length >= args.limit) {
        return result()
      }
    }
    retain(bytes.subarray(segmentStart))
    offset += length
  }
  if (offset === args.snapshotSize) {
    acceptLine(offset, true)
  } else if (droppingOversizedRecord) {
    nextOffset = offset
  }
  return result()

  function retain(part: Buffer): void {
    if (droppingOversizedRecord) {
      return
    }
    lineBytes += part.length
    if (lineBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      oversizedRecordCount++
      parts = []
      droppingOversizedRecord = true
    } else {
      parts.push(part)
    }
  }

  function acceptLine(lineEnd: number, trailing: boolean): boolean {
    if (!droppingOversizedRecord && lineBytes > 0) {
      let text = ''
      let valid = true
      try {
        text = transcriptUtf8.decode(Buffer.concat(parts))
        JSON.parse(text)
      } catch {
        valid = false
        if (trailing) {
          truncatedRecordCount++
        } else {
          malformedRecordCount++
        }
      }
      if (valid) {
        const message = args.decode?.(text, transcriptFallbackId(file.filePath, lineStart)) ?? null
        const record = { byteOffset: lineStart, text }
        const bytes = Buffer.byteLength(JSON.stringify({ record, message }))
        if (payloadBytes + bytes > args.maxPayloadBytes) {
          if (sourceRecords.length === 0) {
            throw new Error('A transcript record exceeds the complete capture payload limit.')
          }
          return false
        }
        payloadBytes += bytes
        sourceRecords.push(record)
        if (message) {
          messages.push(message)
        }
      }
    }
    nextOffset = lineEnd
    lineStart = lineEnd
    parts = []
    lineBytes = 0
    droppingOversizedRecord = false
    return true
  }

  function result() {
    return {
      messages,
      sourceRecords,
      nextOffset,
      droppingOversizedRecord,
      malformedRecordCount,
      oversizedRecordCount,
      truncatedRecordCount
    }
  }
}
