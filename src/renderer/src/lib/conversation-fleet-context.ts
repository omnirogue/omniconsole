import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { readProvider, readStructured } from './conversation-fleet-context-reader'
import {
  CONVERSATION_FLEET_SOURCE_CHANGED,
  resolveSidebarSource,
  type CapturedConversationFleetContext,
  type ConversationFleetContextSource
} from './conversation-fleet-context-source'
import { formatSessionWorkOutput } from './session-work-output'
import { readCapturedAssistantSummary } from './conversation-fleet-context-summary'
import type { SidebarSession } from './sidebar-sessions'

export type { CapturedConversationFleetContext } from './conversation-fleet-context-source'

async function capture(
  source: ConversationFleetContextSource,
  signal: AbortSignal
): Promise<CapturedConversationFleetContext> {
  signal.throwIfAborted()
  const result =
    source.sourceKind === 'structured'
      ? await readStructured(source, signal)
      : await readProvider(source, signal)
  signal.throwIfAborted()
  const readable = formatSessionWorkOutput(result.messages)
  const sourceSummary = readCapturedAssistantSummary(result.messages)
  if (!readable.trim() && !result.sourceRawTranscript.trim()) {
    throw new Error('The source conversation has no readable transcript yet.')
  }
  const transcript =
    readable.trim() || result.sourceRawFormat === 'structured-timeline-jsonl'
      ? readable
      : `Original conversation records:\n\n${result.sourceRawTranscript}`
  if (!transcript.trim()) {
    throw new Error('The source conversation has no readable transcript yet.')
  }
  return {
    ...source,
    transcript,
    sourceContextWarnings: result.warnings,
    sourceRawTranscript: result.sourceRawTranscript,
    sourceRawFormat: result.sourceRawFormat,
    ...(sourceSummary === undefined ? {} : { sourceSummary }),
    ...(result.sourceTurnId ? { sourceTurnId: result.sourceTurnId } : {}),
    ...(result.sourceRuntimeFence === undefined
      ? {}
      : { sourceRuntimeFence: result.sourceRuntimeFence })
  }
}

/** Capture every readable turn without consulting terminal tails or the active workspace. */
export async function readConversationFleetContext(
  session: SidebarSession,
  signal: AbortSignal
): Promise<CapturedConversationFleetContext> {
  signal.throwIfAborted()
  const source = resolveSidebarSource(session)
  const result = await capture(source, signal)
  if (JSON.stringify(resolveSidebarSource(session)) !== JSON.stringify(source)) {
    throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
  }
  return result
}

/** Vault rows already carry their exact provider identity and owning host. */
export function readAiVaultConversationFleetContext(
  session: AiVaultSession,
  signal: AbortSignal
): Promise<CapturedConversationFleetContext> {
  return capture(
    {
      title: session.title,
      sourceSessionId: session.structuredSession?.sessionId ?? session.sessionId,
      sourceWorkspacePath: session.cwd ?? '',
      sourceHostId: session.executionHostId,
      sourceAgent: session.agent,
      sourceKind: session.structuredSession ? 'structured' : 'provider',
      sourceTranscriptPath: session.filePath
    },
    signal
  )
}
