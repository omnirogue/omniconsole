import type { ConversationSource } from '../../shared/conversation-source'
import {
  sessionContextProcessSchema,
  type SessionContextQueueIdentity,
  type SessionContextQueueOrigin
} from '../../shared/session-context-queue'
import type { OrcaRuntimeService } from './omni-runtime'
import { readPaneAgentPresence } from './prompt-queue-agent-presence'

type ContextRuntime = Pick<
  OrcaRuntimeService,
  | 'getLastAgentHookRowForPane'
  | 'getReportedProviderSessionsForPane'
  | 'resolveTerminalPane'
  | 'readTerminalProcessEvidence'
  | 'assertTerminalAgentProcess'
>

const CONTEXT_RECEIVER_CHANGED =
  'The original session cannot be confirmed in this pane. Its saved context was not sent.'

/** Synchronous identity check also used by the writer's revocable fence. */
export function sessionContextQueueRefusal(
  runtime: ContextRuntime,
  source: ConversationSource,
  identity: SessionContextQueueIdentity
): string | null {
  if (identity.kind === 'structured') {
    return source.kind === 'structured' && source.sessionId === identity.sessionId
      ? null
      : CONTEXT_RECEIVER_CHANGED
  }
  if (source.kind !== 'pty') {
    return CONTEXT_RECEIVER_CHANGED
  }
  try {
    const pane = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    const row = runtime.getLastAgentHookRowForPane(source.paneKey)
    const provider = runtime.getReportedProviderSessionsForPane(source.paneKey)[0]
    return pane.executionHostId === 'local' &&
      pane.connected &&
      row?.connectionId === null &&
      row.agentType === identity.agent &&
      (!row.worktreeId || row.worktreeId === source.worktreeId) &&
      row.providerSession?.key === identity.providerSession.key &&
      row.providerSession.id === identity.providerSession.id &&
      provider?.key === identity.providerSession.key &&
      provider.id === identity.providerSession.id
      ? null
      : CONTEXT_RECEIVER_CHANGED
  } catch {
    return CONTEXT_RECEIVER_CHANGED
  }
}

/** Capture on the execution owner, never accept a renderer-supplied process proof. */
export async function prepareSessionContextQueueOrigin(
  runtime: ContextRuntime,
  source: ConversationSource,
  identity: SessionContextQueueIdentity
): Promise<SessionContextQueueOrigin> {
  const initialRefusal = sessionContextQueueRefusal(runtime, source, identity)
  if (initialRefusal) {
    throw new Error(initialRefusal)
  }
  if (identity.kind === 'structured') {
    return { kind: 'session-context', identity }
  }
  const presence = await readPaneAgentPresence(runtime, source)
  const row = runtime.getLastAgentHookRowForPane(source.paneKey)
  if (
    presence.kind !== 'proven' ||
    presence.proof.agent !== identity.agent ||
    !row ||
    (row.evidenceObservedAt ?? row.receivedAt) < presence.proof.startTimeMs ||
    sessionContextQueueRefusal(runtime, source, identity)
  ) {
    throw new Error(CONTEXT_RECEIVER_CHANGED)
  }
  return {
    kind: 'session-context',
    identity,
    process: sessionContextProcessSchema.parse(presence.proof)
  }
}
