import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeExitedNativeChatSession } from './native-chat-exited-session-relaunch'

const initialState = useAppStore.getState()
beforeEach(() =>
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: 'local' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt', repoId: 'repo-1', path: '/repo/wt' }] }
  } as never)
)

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

it.each(['codex', 'claude'] as const)(
  'resumes exited %s chat into a Chat tab with its recorded session and sandbox',
  (agent) => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'old:leaf',
      tabId: 'old',
      worktreeId: 'wt',
      agent,
      providerSession: { key: 'session_id', id: 'session-to-keep' },
      prompt: 'Earlier conversation',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      launchConfig: {
        agentArgs: '--sandbox workspace-write --ask-for-approval on-request',
        agentEnv: {}
      }
    }
    useAppStore.setState({
      activeWorktreeId: 'wt',
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })
    expect(resumeExitedNativeChatSession({ terminalTabId: 'old', record })).toBe(true)
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree.wt[0]
    expect(state.unifiedTabsByWorktree.wt.find((entry) => entry.id === tab.id)?.viewMode).toBe(
      'chat'
    )
    expect(tab.launchAgent).toBe(agent)
    expect(state.pendingStartupByTabId[tab.id]?.resumeProviderSession).toEqual(
      record.providerSession
    )
    expect(state.pendingStartupByTabId[tab.id]?.launchConfig?.agentArgs).toBe(
      record.launchConfig?.agentArgs
    )
  }
)
