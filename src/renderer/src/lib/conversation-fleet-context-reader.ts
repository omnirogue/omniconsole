import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type {
  NativeChatTranscriptCursor,
  NativeChatTranscriptPageResult
} from '../../../shared/native-chat-transcript-page'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'
import {
  CONVERSATION_FLEET_SOURCE_CHANGED,
  type CapturedConversationFleetContext,
  type ConversationFleetContextSource
} from './conversation-fleet-context-source'

type Capture = {
  messages: NativeChatMessage[]
  warnings: string[]
  sourceRawTranscript: string
  sourceRawFormat: CapturedConversationFleetContext['sourceRawFormat']
  sourceTurnId?: string
  sourceRuntimeFence?: number
}

function owningTarget(hostId: ExecutionHostId, runtimeEnvironmentId?: string): RuntimeClientTarget {
  const host = parseExecutionHostId(hostId)
  if (!host) {
    throw new Error('The source conversation has no verified execution host.')
  }
  if (runtimeEnvironmentId) {
    return { kind: 'environment', environmentId: runtimeEnvironmentId }
  }
  return host.kind === 'runtime'
    ? { kind: 'environment', environmentId: host.environmentId }
    : { kind: 'local' }
}

export async function readStructured(
  source: ConversationFleetContextSource,
  signal: AbortSignal
): Promise<Capture> {
  const target = owningTarget(source.sourceHostId, source.sourceRuntimeEnvironmentId)
  const pages: AgentJournalRenderItem[][] = []
  const warnings = new Set<string>()
  let cursor: AgentJournalCursor | undefined
  let epoch: string | undefined
  let sourceRuntimeFence: number | undefined
  while (true) {
    signal.throwIfAborted()
    const result = await callRuntimeRpc<AgentSessionHistoryResult>(
      target,
      'agentSession.history',
      {
        sessionId: source.sourceSessionId,
        direction: cursor ? 'before' : 'tail',
        ...(cursor ? { cursor } : {}),
        limit: AGENT_SESSION_HISTORY_MAX_LIMIT
      },
      { signal, timeoutMs: 30_000 }
    )
    signal.throwIfAborted()
    if (
      !result.ok ||
      result.page.sessionId !== source.sourceSessionId ||
      (epoch && epoch !== result.page.epoch)
    ) {
      throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
    }
    const page = result.page
    if (!Array.isArray(page.items) || typeof page.hasOlder !== 'boolean') {
      throw new Error('The source runtime cannot verify complete structured conversation history.')
    }
    if (!cursor) {
      sourceRuntimeFence = page.fence
    }
    epoch = page.epoch
    pages.push(page.items)
    for (const item of page.items) {
      const payload =
        item.body.kind === 'tool-call'
          ? item.body.output
          : item.body.kind === 'diff'
            ? item.body.patch
            : undefined
      if (payload?.truncated) {
        warnings.add(
          `Tool payload ${payload.digest} is a ${payload.byteLength}-byte source-host artifact; the conversation includes its retained preview.`
        )
      }
    }
    if (!page.hasOlder) {
      break
    }
    const next = page.window.oldest
    if (!next || next.epoch !== epoch || (cursor && next.sequence >= cursor.sequence)) {
      throw new Error(
        'The source runtime did not return the earlier conversation history. Update or reconnect it and try again.'
      )
    }
    cursor = next
  }
  const items = new Map<string, AgentJournalRenderItem>()
  for (const page of pages.toReversed()) {
    for (const item of page) {
      const previous = items.get(item.itemId)
      if (!previous || item.revision >= previous.revision) {
        items.set(item.itemId, item)
      }
    }
  }
  const orderedItems = [...items.values()].sort((left, right) => left.sequence - right.sequence)
  const sourceTurnId = activeStructuredAgentSessionTurnId(orderedItems)
  return {
    messages: projectStructuredItemsToNativeChat(orderedItems),
    warnings: [...warnings],
    sourceRawTranscript: orderedItems.map((item) => JSON.stringify(item)).join('\n'),
    sourceRawFormat: 'structured-timeline-jsonl',
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(sourceRuntimeFence === undefined ? {} : { sourceRuntimeFence })
  }
}

export async function readProvider(
  source: ConversationFleetContextSource,
  signal: AbortSignal
): Promise<Capture> {
  const host = parseExecutionHostId(source.sourceHostId)
  const connectionId = host?.kind === 'ssh' ? host.targetId : null
  const pages: NativeChatMessage[][] = []
  const rawPages: string[] = []
  const warnings = new Set<string>()
  let cursor: NativeChatTranscriptCursor | undefined
  let sourceRawFormat: Capture['sourceRawFormat'] = 'provider-jsonl'
  let format: 'jsonl' | 'json' | undefined
  while (true) {
    signal.throwIfAborted()
    const result = await callRuntimeRpc<NativeChatTranscriptPageResult>(
      owningTarget(source.sourceHostId, source.sourceRuntimeEnvironmentId),
      'nativeChat.readTranscriptPage',
      {
        agent: source.sourceAgent,
        sessionId: source.sourceSessionId,
        transcriptPath: source.sourceTranscriptPath,
        ...(connectionId ? { connectionId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 200
      },
      {
        signal,
        timeoutMs:
          !cursor && (!source.sourceTranscriptPath || source.sourceAgent === 'opencode')
            ? 150_000
            : 30_000
      }
    )
    signal.throwIfAborted()
    if (result.source?.connectionId !== connectionId) {
      throw new Error('The transcript response did not verify the source execution host.')
    }
    if ('error' in result) {
      throw new Error(result.error)
    }
    if (!Array.isArray(result.messages)) {
      throw new Error('The source conversation transcript is not available yet.')
    }
    for (const warning of result.warnings ?? []) {
      warnings.add(warning)
    }
    if (
      result.malformedRecordCount !== 0 ||
      result.oversizedRecordCount !== 0 ||
      result.truncatedRecordCount !== 0
    ) {
      throw new Error(
        'The source transcript contains unreadable or incomplete records. Its complete conversation could not be captured.'
      )
    }
    const coverage = result.coverage
    if (
      coverage?.rawRecords !== 'complete' ||
      !Array.isArray(result.sourceRecords) ||
      coverage.fromByteOffset !== (cursor?.byteOffset ?? 0) ||
      (cursor && coverage.snapshotBytes !== cursor.snapshotSize) ||
      coverage.toByteOffset > coverage.snapshotBytes ||
      (result.complete && coverage.toByteOffset !== coverage.snapshotBytes)
    ) {
      throw new Error('The source runtime did not return the complete original transcript records.')
    }
    if (format && format !== coverage.format) {
      throw new Error('The source transcript format changed during capture.')
    }
    format = coverage.format
    if (coverage.projection === 'raw-only') {
      warnings.add(
        'This provider has no display parser; its complete original transcript records are included.'
      )
    }
    sourceRawFormat = coverage.format === 'json' ? 'provider-json' : 'provider-jsonl'
    pages.push(result.messages)
    rawPages.push(
      result.sourceRecords.map((record) => record.text).join(format === 'json' ? '' : '\n')
    )
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
      next.connectionId !== connectionId ||
      next.sessionId !== source.sourceSessionId ||
      (cursor &&
        (next.byteOffset <= cursor.byteOffset ||
          next.filePath !== cursor.filePath ||
          next.snapshotSize !== cursor.snapshotSize ||
          next.fileIdentity !== cursor.fileIdentity ||
          next.sourceEpoch !== cursor.sourceEpoch))
    ) {
      throw new Error(
        'The source runtime cannot verify complete conversation history. Update or reconnect it and try again.'
      )
    }
    cursor = next
  }
  const sourceRawTranscript = rawPages.filter(Boolean).join(format === 'json' ? '' : '\n')
  if (format === 'json') {
    const document: unknown = JSON.parse(sourceRawTranscript)
    if (
      !document ||
      typeof document !== 'object' ||
      (source.sourceAgent === 'gemini' &&
        (!('messages' in document) || !Array.isArray(document.messages)))
    ) {
      throw new Error('The source JSON document does not contain a complete conversation.')
    }
    for (const field of ['sessionId', 'session_id']) {
      const identity: unknown = (document as Record<string, unknown>)[field]
      if (typeof identity === 'string' && identity !== source.sourceSessionId) {
        throw new Error('The source JSON document belongs to another conversation.')
      }
    }
  }
  return { messages: pages.flat(), warnings: [...warnings], sourceRawTranscript, sourceRawFormat }
}
