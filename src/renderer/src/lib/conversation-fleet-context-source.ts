import { useAppStore } from '@/store'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { ConversationFleetContext } from '../../../shared/conversation-fleet-workflow'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import { providerSessionFolderKey, structuredSessionFolderKey } from './session-folder-identity'
import type { SidebarSession } from './sidebar-sessions'
import { resolveWorktreeOperationRouteForHost } from './worktree-operation-route'
import { resolveExactWorktreeRoute } from './worktree-owner-route'

export type CapturedConversationFleetContext = ConversationFleetContext & {
  sourceHostId: ExecutionHostId
  sourceRuntimeEnvironmentId?: string
  sourceAgent: string
  sourceKind: 'structured' | 'provider'
  /** Provenance on the source host; never a local attachment path. */
  sourceTranscriptPath?: string
  sourceContextWarnings: string[]
  sourceRawTranscript: string
  sourceRawFormat: 'provider-jsonl' | 'provider-json' | 'structured-timeline-jsonl'
  /** Last readable assistant response from this capture; absent when its role cannot be verified. */
  sourceSummary?: string
  sourceTurnId?: string
  sourceRuntimeFence?: number
  sourceProviderSessionId?: string
  sourceWorkingStartedAt?: number
  sourcePrompt?: string
  sourceTerminalHandle?: string
}

export type ConversationFleetContextSource = Omit<
  CapturedConversationFleetContext,
  | 'transcript'
  | 'sourceContextWarnings'
  | 'sourceRawTranscript'
  | 'sourceRawFormat'
  | 'sourceSummary'
>
export const CONVERSATION_FLEET_SOURCE_CHANGED =
  'The source conversation changed while preparing its handoff. Try again.'

export function resolveConversationFleetSourceRuntimeEnvironment(
  session: SidebarSession
): string | undefined {
  const state = useAppStore.getState()
  const host = parseExecutionHostId(session.hostId)
  const scope = parseWorkspaceKey(session.worktreeId)
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : session.worktreeId
  if (!host) {
    throw new Error('The source conversation has no verified execution host.')
  }
  if (host.kind === 'ssh') {
    const owners = [
      ...Object.values(state.worktreesByRepo ?? {}).flat(),
      ...Object.values(state.detectedWorktreesByRepo ?? {}).flatMap((entry) => entry.worktrees)
    ].filter((owner) => owner.id === worktreeId && owner.hostId === host.id)
    const transports = new Set<string | null>()
    for (const owner of owners) {
      const resolved = resolveExactWorktreeRoute(state, owner)
      if (resolved.kind !== 'resolved') {
        throw new Error('The source SSH workspace has no unambiguous owning runtime.')
      }
      transports.add(resolved.route.runtimeEnvironmentId)
    }
    if (transports.size > 1) {
      throw new Error('The source SSH workspace has more than one owning runtime.')
    }
  }
  return (
    resolveWorktreeOperationRouteForHost(state, worktreeId, host.id)?.runtimeEnvironmentId ??
    undefined
  )
}

function workspacePath(session: SidebarSession): string {
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(session.worktreeId)
  if (scope?.type === 'folder') {
    const owner = findFolderWorkspaceOwner(
      state,
      scope.folderWorkspaceId,
      session.hostId ?? undefined
    )
    const folder = state.folderWorkspaces.find((item) => item === owner)
    if (folder?.folderPath) {
      return folder.folderPath
    }
  }
  const path = state.getKnownWorktreeById(session.worktreeId, session.hostId ?? undefined)?.path
  if (!path) {
    throw new Error('The source workspace is no longer available on its execution host.')
  }
  return path
}

export function resolveSidebarSource(session: SidebarSession): ConversationFleetContextSource {
  if (!session.hostId) {
    throw new Error('The source conversation has no verified execution host.')
  }
  const state = useAppStore.getState()
  const base = {
    title: session.label,
    sourceHostId: session.hostId,
    sourceRuntimeEnvironmentId: resolveConversationFleetSourceRuntimeEnvironment(session),
    sourceWorkspacePath: workspacePath(session)
  }
  if (session.kind === 'structured') {
    const tab = state.unifiedTabsByWorktree[session.worktreeId]?.find(
      (item) => item.id === session.tabId
    )
    if (
      !tab ||
      tab.contentType !== 'agent-session' ||
      (tab.executionHostId && tab.executionHostId !== session.hostId) ||
      (session.sessionKey &&
        session.sessionKey !== structuredSessionFolderKey(session.hostId, tab.entityId))
    ) {
      throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
    }
    return {
      ...base,
      sourceSessionId: tab.entityId,
      sourceAgent: tab.agentSessionAgent ?? session.agent,
      sourceKind: 'structured'
    }
  }
  const live = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : undefined
  const retained = session.paneKey
    ? state.sleepingAgentSessionsByPaneKey[session.paneKey]
    : undefined
  if (
    (live?.worktreeId && live.worktreeId !== session.worktreeId) ||
    (!live && retained && retained.worktreeId !== session.worktreeId)
  ) {
    throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
  }
  const tab = state.tabsByWorktree[session.worktreeId]?.find((item) => item.id === session.tabId)
  const startup = session.tabId ? state.pendingStartupByTabId[session.tabId] : undefined
  const claim = session.tabId ? state.automaticAgentResumeClaimsByTabId[session.tabId] : undefined
  // A new live session without identity must never borrow its pane's old history.
  const provider: AgentProviderSessionMetadata | undefined = live
    ? live.providerSession
    : (retained?.providerSession ??
      claim?.providerSession ??
      startup?.resumeProviderSession ??
      (tab?.aiVaultTitle ? { key: 'session_id', id: tab.aiVaultTitle.sessionId } : undefined))
  const agent = live?.agentType ?? retained?.agent ?? tab?.aiVaultTitle?.agent ?? session.agent
  if (!provider) {
    throw new Error('The source conversation has not saved a readable session identity yet.')
  }
  if (
    session.sessionKey &&
    providerSessionFolderKey({
      hostId: session.hostId,
      worktreeId: session.worktreeId,
      agent,
      providerSession: provider
    }) !== session.sessionKey
  ) {
    throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
  }
  const host = parseExecutionHostId(session.hostId)
  const connectionId = live ? live.connectionId : retained?.connectionId
  if (
    (connectionId && (host?.kind !== 'ssh' || host.targetId !== connectionId)) ||
    (connectionId === null && host?.kind === 'ssh')
  ) {
    throw new Error(CONVERSATION_FLEET_SOURCE_CHANGED)
  }
  return {
    ...base,
    sourceSessionId: provider.id,
    sourceAgent: agent,
    sourceKind: 'provider',
    sourceProviderSessionId: provider.id,
    ...(provider.transcriptPath ? { sourceTranscriptPath: provider.transcriptPath } : {}),
    ...(live?.state === 'working' ? { sourceWorkingStartedAt: live.stateStartedAt } : {}),
    ...(live ? { sourcePrompt: live.prompt } : {}),
    ...(live?.terminalHandle ? { sourceTerminalHandle: live.terminalHandle } : {})
  }
}
