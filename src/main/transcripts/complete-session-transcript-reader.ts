import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryRequest,
  type AgentSessionHistoryResult
} from '../../shared/agent-session-wire'
import type {
  NativeChatTranscriptCursor,
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import { TRANSCRIPT_MAX_BYTES, transcriptSourceLength } from '../../shared/transcript-render'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { readNativeChatTranscriptPage } from '../native-chat/transcript-page-reader'

export type CompleteTranscriptSource = {
  kind: 'provider' | 'structured'
  agent: string
  sessionId: string
  transcriptPath?: string
  expectedConnectionId: string | null
}
export class IncompleteTranscriptError extends Error {}
export class CompleteTranscriptTooLargeError extends Error {}
type Readers = {
  provider: (
    args: NativeChatTranscriptPageArgs,
    signal?: AbortSignal
  ) => Promise<NativeChatTranscriptPageResult>
  structured: (args: AgentSessionHistoryRequest) => AgentSessionHistoryResult
}
const defaultReaders: Readers = {
  provider: readNativeChatTranscriptPage,
  structured: (args) => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new IncompleteTranscriptError()
    }
    return host.history(args)
  }
}
// Bound input before combining pages; the final rendered document retains the existing 8 MiB cap.
const MAX_SOURCE_BYTES = 32 * 1024 * 1024

async function readProvider(
  source: CompleteTranscriptSource,
  readers: Readers,
  signal?: AbortSignal
): Promise<NativeChatMessage[]> {
  const messages: NativeChatMessage[] = []
  const json: string[] = []
  let cursor: NativeChatTranscriptCursor | undefined
  let format: 'json' | 'jsonl' | undefined
  let messageBytes = 0
  for (;;) {
    signal?.throwIfAborted()
    const result = await readers.provider(
      {
        agent: source.agent as AgentType,
        sessionId: source.sessionId,
        ...(source.transcriptPath ? { transcriptPath: source.transcriptPath } : {}),
        ...(source.expectedConnectionId ? { connectionId: source.expectedConnectionId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 200
      },
      signal
    )
    signal?.throwIfAborted()
    if (
      'error' in result ||
      result.source.connectionId !== source.expectedConnectionId ||
      !Array.isArray(result.messages) ||
      result.malformedRecordCount !== 0 ||
      result.oversizedRecordCount !== 0 ||
      result.truncatedRecordCount !== 0
    ) {
      throw new IncompleteTranscriptError()
    }
    const coverage = result.coverage
    if (
      !coverage ||
      coverage.rawRecords !== 'complete' ||
      coverage.projection !== 'display' ||
      !Array.isArray(result.sourceRecords) ||
      coverage.fromByteOffset !== (cursor?.byteOffset ?? 0) ||
      !Number.isSafeInteger(coverage.snapshotBytes) ||
      coverage.snapshotBytes < 0 ||
      coverage.toByteOffset < coverage.fromByteOffset ||
      coverage.toByteOffset > coverage.snapshotBytes ||
      (cursor && coverage.snapshotBytes !== cursor.snapshotSize) ||
      (result.complete && coverage.toByteOffset !== coverage.snapshotBytes) ||
      (format && format !== coverage.format)
    ) {
      throw new IncompleteTranscriptError()
    }
    if (coverage.snapshotBytes > MAX_SOURCE_BYTES) {
      throw new CompleteTranscriptTooLargeError()
    }
    format = coverage.format
    const size = transcriptSourceLength(result.messages)
    messageBytes += size.length
    if (size.overBudget || messageBytes > TRANSCRIPT_MAX_BYTES) {
      throw new CompleteTranscriptTooLargeError()
    }
    messages.push(...result.messages)
    if (format === 'json') {
      json.push(...result.sourceRecords.map((record) => record.text))
    }
    if (result.complete === true) {
      break
    }
    const next = result.cursor
    if (
      result.complete !== false ||
      !next ||
      !Number.isSafeInteger(next.byteOffset) ||
      next.byteOffset <= 0 ||
      next.byteOffset !== coverage.toByteOffset ||
      next.connectionId !== source.expectedConnectionId ||
      next.sessionId !== source.sessionId ||
      next.agent !== source.agent ||
      next.snapshotSize !== coverage.snapshotBytes ||
      (cursor &&
        (next.byteOffset <= cursor.byteOffset ||
          next.filePath !== cursor.filePath ||
          next.fileIdentity !== cursor.fileIdentity ||
          next.sourceEpoch !== cursor.sourceEpoch))
    ) {
      throw new IncompleteTranscriptError()
    }
    cursor = next
  }
  if (format === 'json') {
    const document: unknown = JSON.parse(json.join(''))
    if (
      !document ||
      typeof document !== 'object' ||
      Array.isArray(document) ||
      (source.agent === 'gemini' &&
        (!('messages' in document) || !Array.isArray(document.messages)))
    ) {
      throw new IncompleteTranscriptError()
    }
    for (const field of ['sessionId', 'session_id']) {
      const identity = (document as Record<string, unknown>)[field]
      if (typeof identity === 'string' && identity !== source.sessionId) {
        throw new IncompleteTranscriptError()
      }
    }
  }
  return messages
}

function readStructured(
  source: CompleteTranscriptSource,
  readers: Readers,
  signal?: AbortSignal
): NativeChatMessage[] {
  if (source.expectedConnectionId !== null) {
    throw new IncompleteTranscriptError()
  }
  const items = new Map<string, AgentJournalRenderItem>()
  let cursor: AgentJournalCursor | undefined
  let epoch: string | undefined
  let fence: number | undefined
  let bytes = 0
  for (;;) {
    signal?.throwIfAborted()
    const result = readers.structured({
      sessionId: source.sessionId,
      direction: cursor ? 'before' : 'tail',
      ...(cursor ? { cursor } : {}),
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    if (
      !result.ok ||
      result.page.sessionId !== source.sessionId ||
      (epoch && epoch !== result.page.epoch)
    ) {
      throw new IncompleteTranscriptError()
    }
    const page = result.page
    if (
      !Array.isArray(page.items) ||
      typeof page.hasOlder !== 'boolean' ||
      typeof page.fence !== 'number' ||
      (fence !== undefined && page.fence !== fence)
    ) {
      throw new IncompleteTranscriptError()
    }
    epoch = page.epoch
    fence = page.fence
    for (const item of page.items) {
      const payload =
        item.body.kind === 'tool-call'
          ? item.body.output
          : item.body.kind === 'diff'
            ? item.body.patch
            : undefined
      if (payload?.truncated) {
        throw new IncompleteTranscriptError()
      }
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (bytes > MAX_SOURCE_BYTES) {
        throw new CompleteTranscriptTooLargeError()
      }
      const previous = items.get(item.itemId)
      if (!previous || previous.revision < item.revision) {
        items.set(item.itemId, item)
      }
    }
    if (!page.hasOlder) {
      break
    }
    const next = page.window.oldest
    if (!next || next.epoch !== epoch || (cursor && next.sequence >= cursor.sequence)) {
      throw new IncompleteTranscriptError()
    }
    cursor = next
  }
  return projectStructuredItemsToNativeChat(
    [...items.values()].sort((a, b) => a.sequence - b.sequence)
  )
}

/** Same cursor/identity/coverage requirements as full conversation capture; no tail or raw-only fallback. */
export async function readCompleteSessionTranscript(
  source: CompleteTranscriptSource,
  signal?: AbortSignal,
  readers: Readers = defaultReaders
): Promise<NativeChatMessage[]> {
  return source.kind === 'structured'
    ? readStructured(source, readers, signal)
    : readProvider(source, readers, signal)
}
