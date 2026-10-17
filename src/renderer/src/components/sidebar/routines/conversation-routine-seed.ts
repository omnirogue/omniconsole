import type { AppState } from '@/store'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

export type ConversationRoutineSeed = {
  hostId?: string
  workspaceId?: string
  projectId?: string
  cron: string
  name?: string
  prompt?: string
  agentId?: SidebarSession['agent']
}

export function conversationRoutineSeed(
  state: AppState,
  sessionKey: string
): ConversationRoutineSeed | null {
  const session = buildSidebarSessions(state).find(
    (item) => (item.sessionKey ?? item.rowKey) === sessionKey
  )
  if (!session || session.unavailable || !isTuiAgent(session.agent)) {
    return null
  }
  const workspace = state.getKnownWorktreeById(session.worktreeId, session.hostId ?? undefined)
  if (!workspace) {
    return null
  }
  const hostId = session.hostId ?? 'local'
  const project =
    state.repos.find(
      (repo) => repo.id === workspace.repoId && getRepoExecutionHostId(repo) === hostId
    ) ??
    state.repos.find(
      (repo) => repo.id === state.activeRepoId && getRepoExecutionHostId(repo) === hostId
    ) ??
    state.repos.find((repo) => getRepoExecutionHostId(repo) === hostId)
  const entry = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : null
  const sleeping = session.paneKey ? state.sleepingAgentSessionsByPaneKey[session.paneKey] : null
  const launch = session.tabId ? state.nativeChatLaunchPromptByTabId[session.tabId] : null
  const prompt =
    entry?.stateHistory.find((item) => item.prompt?.trim())?.prompt ||
    entry?.prompt ||
    launch?.text ||
    sleeping?.prompt ||
    session.label
  const outcome = entry?.lastCompletedAssistantMessage || entry?.lastAssistantMessage
  return {
    hostId,
    workspaceId: session.worktreeId,
    projectId: project?.id,
    cron: '0 9 * * *',
    name: session.label,
    agentId: session.agent,
    prompt: outcome ? `${prompt}\n\nPrevious result for context:\n${outcome.slice(-12000)}` : prompt
  }
}
