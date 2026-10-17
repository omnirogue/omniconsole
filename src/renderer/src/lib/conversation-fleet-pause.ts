import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from './sidebar-sessions'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  CONVERSATION_FLEET_SOURCE_CHANGED,
  resolveConversationFleetSourceRuntimeEnvironment,
  resolveSidebarSource
} from './conversation-fleet-context-source'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type {
  AgentSessionCancelResult,
  AgentSessionHistoryResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { ConsoleWorkflowAdmission } from '../../../shared/console-workflow-types'
import { isConversationFleetAdmission } from '../../../shared/conversation-fleet-admission'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalResolvePane,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'

export type ConversationFleetPauseSource = {
  sourceSessionId: string
  sourceHostId?: ExecutionHostId
  sourceRuntimeEnvironmentId?: string
  sourceTurnId?: string
  sourceRuntimeFence?: number
  sourceProviderSessionId?: string
  sourceWorkingStartedAt?: number
  sourcePtyId?: string
  sourceTerminalHandle?: string
  sourcePrompt?: string
}

export type ConversationFleetPauseResult = {
  state: 'paused' | 'already-idle' | 'source-changed' | 'unverifiable'
  message: string
}

const changed = (): ConversationFleetPauseResult => ({
  state: 'source-changed',
  message: translate(
    'conversationFleet.sourceChangedAfterCapture',
    'The source changed after capture. No pause was sent to a different conversation or turn.'
  )
})
const idle = (): ConversationFleetPauseResult => ({
  state: 'already-idle',
  message: translate(
    'conversationFleet.sourceAlreadyIdle',
    'The source conversation is already idle.'
  )
})
const paused = (): ConversationFleetPauseResult => ({
  state: 'paused',
  message: translate(
    'conversationFleet.sourcePaused',
    'The source conversation is paused; its transcript is retained.'
  )
})

function ownerTarget(
  session: SidebarSession,
  source: ConversationFleetPauseSource
): RuntimeClientTarget {
  const host = parseExecutionHostId(session.hostId ?? 'local')
  if (!host) {
    throw new Error('The source execution host is unavailable.')
  }
  const environmentId = resolveConversationFleetSourceRuntimeEnvironment(session)
  if (
    source.sourceHostId &&
    (source.sourceHostId !== host.id || source.sourceRuntimeEnvironmentId !== environmentId)
  ) {
    throw new Error('The source execution owner changed after capture. No pause was sent.')
  }
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

async function pauseStructured(
  session: SidebarSession,
  source: ConversationFleetPauseSource,
  target: RuntimeClientTarget,
  signal?: AbortSignal
): Promise<ConversationFleetPauseResult> {
  const tab = useAppStore
    .getState()
    .unifiedTabsByWorktree[session.worktreeId]?.find(
      (entry) => entry.id === session.tabId && entry.contentType === 'agent-session'
    )
  if (!tab || tab.entityId !== source.sourceSessionId) {
    return changed()
  }
  const history = await callRuntimeRpc<AgentSessionHistoryResult>(
    target,
    'agentSession.history',
    {
      sessionId: source.sourceSessionId,
      direction: 'tail',
      limit: 200
    },
    { timeoutMs: 15_000, signal }
  )
  if (!history.ok || history.page.sessionId !== source.sourceSessionId) {
    throw new Error('The source journal could not be verified before pausing.')
  }
  const observedTurn = activeStructuredAgentSessionTurnId(history.page.items)
  const observedLifecycle = history.page.items.some(
    (item) => item.body.kind === 'status' && item.body.turnLifecycle
  )
  if (observedLifecycle && !observedTurn) {
    return idle()
  }
  if (
    (observedLifecycle && observedTurn !== source.sourceTurnId) ||
    history.page.fence !== source.sourceRuntimeFence
  ) {
    return changed()
  }
  const turnId = source.sourceTurnId
  if (!turnId) {
    throw new Error('The captured source has no verified active turn to pause.')
  }
  if (source.sourceRuntimeFence === undefined) {
    throw new Error('The source ownership fence is unavailable.')
  }
  const fields = { turnId }
  const result = await callRuntimeRpc<AgentSessionMutationResult<AgentSessionCancelResult>>(
    target,
    'agentSession.cancel',
    {
      envelope: {
        sessionId: source.sourceSessionId,
        clientOperationId: `fleet-pause-${crypto.randomUUID()}`,
        expectedRuntimeFence: source.sourceRuntimeFence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: source.sourceSessionId,
          fields
        })
      },
      ...fields
    },
    { timeoutMs: 15_000, signal }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  if (result.value.turnId !== turnId || !result.value.cancelled) {
    throw new Error('The source provider did not confirm that its captured turn was paused.')
  }
  return paused()
}

function terminalSourceMatches(
  session: SidebarSession,
  source: ConversationFleetPauseSource,
  checkTurn = true
): boolean {
  const status = session.paneKey
    ? useAppStore.getState().agentStatusByPaneKey[session.paneKey]
    : null
  return Boolean(
    status &&
    source.sourceProviderSessionId &&
    status.providerSession?.id === source.sourceProviderSessionId &&
    (!status.worktreeId || status.worktreeId === session.worktreeId) &&
    (!checkTurn ||
      (source.sourceWorkingStartedAt !== undefined &&
        status.stateStartedAt === source.sourceWorkingStartedAt &&
        (source.sourcePrompt === undefined || status.prompt === source.sourcePrompt)))
  )
}

async function pauseTerminal(
  session: SidebarSession,
  source: ConversationFleetPauseSource,
  target: RuntimeClientTarget,
  signal?: AbortSignal
): Promise<ConversationFleetPauseResult> {
  if (!session.paneKey || !terminalSourceMatches(session, source, false)) {
    return changed()
  }
  const resolved = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
    target,
    'terminal.resolvePane',
    {
      paneKey: session.paneKey,
      worktreeId: session.worktreeId
    },
    { timeoutMs: 15_000, signal }
  )
  const terminal = resolved.terminal
  if (
    !terminal.ptyId ||
    (source.sourcePtyId && terminal.ptyId !== source.sourcePtyId) ||
    (source.sourceTerminalHandle && terminal.handle !== source.sourceTerminalHandle) ||
    (terminal.executionHostId ?? 'local') !== (session.hostId ?? 'local')
  ) {
    throw new Error('The exact source terminal on its execution host could not be verified.')
  }
  const observed = await callRuntimeRpc<{ agentStatus: RuntimeTerminalAgentStatus }>(
    target,
    'terminal.agentStatus',
    { terminal: terminal.handle },
    { timeoutMs: 15_000, signal }
  )
  if (observed.agentStatus.status === 'idle') {
    return idle()
  }
  if (!terminalSourceMatches(session, source)) {
    return changed()
  }
  if (!observed.agentStatus.isRunningAgent || observed.agentStatus.status !== 'working') {
    throw new Error('The source is not confirmed working; no terminal input was sent.')
  }
  // Use the composer's Stop key on this exact handle; never terminate the session or its transcript.
  const sent = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    target,
    'terminal.send',
    {
      terminal: terminal.handle,
      text: '\u001b'
    },
    { timeoutMs: 15_000, signal }
  )
  if (!sent.send.accepted) {
    throw new Error('The execution host did not accept the source pause request.')
  }
  const stopped = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
    target,
    'terminal.wait',
    {
      terminal: terminal.handle,
      for: 'tui-idle',
      timeoutMs: 5000
    },
    { timeoutMs: 7000, signal }
  )
  if (
    !stopped.wait.satisfied ||
    stopped.wait.condition !== 'tui-idle' ||
    stopped.wait.blockedReason
  ) {
    throw new Error('The source pause was requested, but its execution host has not confirmed it.')
  }
  return paused()
}

/** Call only with the admission receipt; a failed pause must never redispatch the fleet workflow. */
export async function pauseConversationAfterFleetDispatch(
  session: SidebarSession,
  source: ConversationFleetPauseSource,
  receipt: ConsoleWorkflowAdmission,
  signal?: AbortSignal
): Promise<ConversationFleetPauseResult> {
  try {
    if (!isConversationFleetAdmission(receipt)) {
      throw new Error('A confirmed fleet admission receipt is required before pausing the source.')
    }
    const target = ownerTarget(session, source)
    return session.kind === 'structured'
      ? await pauseStructured(session, source, target, signal)
      : await pauseTerminal(session, source, target, signal)
  } catch (error) {
    return {
      state: 'unverifiable',
      message: error instanceof Error ? error.message : 'The source pause could not be verified.'
    }
  }
}

/** Explicit user pause uses the same host and turn fences as a handoff pause. */
export async function pauseSidebarSession(
  session: SidebarSession
): Promise<ConversationFleetPauseResult> {
  try {
    if (session.unavailable) {
      throw new Error('Reconnect to the execution host before pausing this session.')
    }
    const { pauseSidebarSessionOnOwner } = await import('./sidebar-session-pause')
    const source = resolveSidebarSource(session)
    const target = ownerTarget(session, source)
    return await pauseSidebarSessionOnOwner(session, source, target)
  } catch (error) {
    if (error instanceof Error && error.message === CONVERSATION_FLEET_SOURCE_CHANGED) {
      return changed()
    }
    return {
      state: 'unverifiable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
