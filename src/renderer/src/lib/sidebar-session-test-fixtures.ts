import {
  buildSidebarSessions,
  type SidebarSession,
  type SidebarSessionSource
} from './sidebar-sessions'
import {
  EMPTY_AGENT_PANE_SNAPSHOT,
  type AgentPaneCard,
  type AgentPaneSnapshot
} from '@/components/attention/agent-pane-snapshot'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'
import { makePaneKey } from '../../../shared/stable-pane-id'

export const SESSION_TEST_LEAF = '00000000-0000-4000-8000-000000000001'
export const SESSION_TEST_WORKTREE = 'repo-a::/project-a'

export function sessionTestSource(): SidebarSessionSource {
  return {
    repos: [{ id: 'repo-a', displayName: 'Project A', executionHostId: 'local' } as Repo],
    worktreesByRepo: {
      'repo-a': [
        {
          id: SESSION_TEST_WORKTREE,
          repoId: 'repo-a',
          displayName: 'main',
          hostId: 'local'
        } as Worktree
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {}
  }
}

export function addSessionTestTab(
  state: SidebarSessionSource,
  tabId = 'tab-a',
  worktreeId = SESSION_TEST_WORKTREE
): TerminalTab {
  const tab: TerminalTab = {
    id: tabId,
    worktreeId,
    ptyId: 'transient-pty',
    title: `Session ${tabId}`,
    launchAgent: 'codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 10
  }
  state.tabsByWorktree[worktreeId] = [...(state.tabsByWorktree[worktreeId] ?? []), tab]
  state.terminalLayoutsByTabId[tabId] = {
    root: { type: 'leaf', leafId: SESSION_TEST_LEAF },
    activeLeafId: SESSION_TEST_LEAF,
    expandedLeafId: null
  }
  return tab
}

export function addSessionTestRecord(
  state: SidebarSessionSource,
  tab: TerminalTab,
  providerId = 'provider-a'
): SleepingAgentSessionRecord {
  const paneKey = makePaneKey(tab.id, SESSION_TEST_LEAF)
  const record: SleepingAgentSessionRecord = {
    paneKey,
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: providerId },
    prompt: 'Work',
    terminalTitle: tab.title,
    state: 'working',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'live'
  }
  state.sleepingAgentSessionsByPaneKey[paneKey] = record
  return record
}

/** Organization fixtures explicitly provide execution instead of relying on an open tab. */
export function workingSessionTestSnapshot(
  source: SidebarSessionSource | readonly SidebarSession[]
): AgentPaneSnapshot {
  const sessions = Array.isArray(source)
    ? source
    : buildSidebarSessions(source as SidebarSessionSource)
  const cards: AgentPaneCard[] = sessions.flatMap((session) =>
    session.paneKey && session.tabId
      ? [
          {
            paneKey: session.paneKey,
            worktreeId: session.worktreeId,
            tabId: session.tabId,
            leafId: null,
            agentType: 'codex',
            bucket: 'working',
            dotState: 'working',
            unseen: false,
            title: session.label,
            stateChangedAt: 10,
            repoName: 'Project',
            worktreeName: 'main'
          }
        ]
      : []
  )
  return {
    ...EMPTY_AGENT_PANE_SNAPSHOT,
    cards,
    cardsByPaneKey: new Map(cards.map((card) => [card.paneKey, card]))
  }
}
