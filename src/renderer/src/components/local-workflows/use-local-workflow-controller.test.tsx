// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { workflowView } from './local-workflow-ui.fixtures'
import { useLocalWorkflowController } from './use-local-workflow-controller'

const calls = vi.hoisted(() => ({
  rpc: vi.fn(),
  launch: vi.fn(),
  focus: vi.fn(),
  plan: vi.fn(),
  attach: vi.fn()
}))
const tab = {
  id: 'workflow-tab',
  worktreeId: 'worktree-1',
  localWorkflow: { preset: 'council', prompt: 'Inspect recovery', executionId: 'execution-1' }
} as TerminalTab
const state = {
  settings: {},
  folderWorkspaces: [],
  activeGroupIdByWorktree: { 'worktree-1': 'group-1' },
  groupsByWorktree: { 'worktree-1': [{ id: 'group-1', activeTabId: 'workflow-tab' }] },
  unifiedTabsByWorktree: {
    'worktree-1': [
      { id: 'workflow-tab', entityId: 'workflow-tab', groupId: 'group-1', viewMode: 'terminal' }
    ]
  },
  tabsByWorktree: { 'worktree-1': [tab] },
  getKnownWorktreeById: () => ({ path: '/repo/worktree' })
}
const view = {
  ...workflowView(),
  state: 'completed' as const,
  result: {
    markdown: 'Verified answer',
    sources: [{ ref: 'receipt', description: 'host receipt' }],
    coverage: ['all calls']
  },
  followUpSeat: {
    id: 'chair',
    agent: 'claude' as const,
    accountId: 'system:claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    lineage: 'anthropic' as const,
    policyRevision: 'route-v1'
  }
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (snapshot: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local'
}))
vi.mock('../../../../shared/workspace-launch-task', () => ({ workspaceLaunchTaskId: () => null }))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: () => 'local:worktree-1'
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: calls.rpc }))
vi.mock('./use-local-workflow-projection', () => ({
  useLocalWorkflowProjection: () => ({
    view,
    loading: false,
    accept: vi.fn(),
    attachLogs: calls.attach
  })
}))
vi.mock('@/lib/local-workflow-follow-up-launch', () => ({
  planLocalWorkflowFollowUpLaunch: calls.plan
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  launchAgentSessionContinuation: calls.launch
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: calls.focus }))
vi.mock('@/lib/local-workflow-conversation', () => ({
  updateLocalWorkflowConversation: vi.fn(),
  persistLocalWorkflowConversationAnchor: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('completed workflow follow-up', () => {
  it('rechecks host Setup, launches a normal Terminal session, and waits for delivery', async () => {
    Object.assign(window, { api: { app: { homeDirectory: '/Users/maintainer' } } })
    calls.rpc.mockImplementation(async (_target, method) =>
      method === 'localWorkflow.show'
        ? view
        : { executionId: 'execution-1', catalog: [{ accountId: 'system:claude' }] }
    )
    calls.plan.mockReturnValue({
      agent: 'claude',
      launchEnv: { CLAUDE_CONFIG_DIR: '/Users/maintainer/.claude' },
      launchPreferences: { model: 'sonnet', effort: 'high' }
    })
    let deliver!: (value: boolean) => void
    const receipt = new Promise<boolean>((resolve) => {
      deliver = resolve
    })
    calls.launch.mockImplementation(async (args) => {
      args.onLaunched({ tabId: 'agent-tab', promptDelivered: receipt })
      return true
    })
    const { result } = renderHook(() => useLocalWorkflowController(tab, true))
    let pending!: Promise<void>
    let settled = false
    act(() => {
      pending = result.current!.followUp!('execution-1', 'What changed?')
      void pending.then(() => {
        settled = true
      })
    })
    await waitFor(() => expect(calls.launch).toHaveBeenCalledTimes(1))
    expect(calls.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'localWorkflow.setup',
      expect.objectContaining({ conversationId: 'workflow-tab', preset: 'council' })
    )
    expect(calls.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'localWorkflow.show',
      expect.objectContaining({ executionId: 'execution-1' })
    )
    expect(calls.plan).toHaveBeenCalledWith(
      expect.objectContaining({ view, catalog: [{ accountId: 'system:claude' }] })
    )
    expect(calls.launch.mock.calls[0][0]).toMatchObject({
      worktreeId: 'worktree-1',
      groupId: 'group-1',
      workspacePath: '/repo/worktree',
      viewModePreference: 'terminal',
      launchPreferences: { model: 'sonnet', effort: 'high' }
    })
    expect(calls.launch.mock.calls[0][0].prompt).toContain(
      'Workflow sources:\nreceipt: host receipt'
    )
    expect(calls.focus).toHaveBeenCalledWith('agent-tab', null)
    expect(settled).toBe(false)
    deliver(true)
    await act(async () => await pending)
    expect(settled).toBe(true)
    expect(state.tabsByWorktree['worktree-1'][0].localWorkflow?.executionId).toBe('execution-1')
  })
})

describe('call logs on demand', () => {
  it('reads one call through the host for Details', async () => {
    const logs = { stdout: 'raw provider output', stderr: '', outputTruncated: false }
    calls.rpc.mockResolvedValue(logs)
    const { result } = renderHook(() => useLocalWorkflowController(tab, true))
    await expect(result.current!.readCall!('execution-1', 'answers/seat-1')).resolves.toEqual(logs)
    expect(calls.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'localWorkflow.readCall', {
      worktree: 'local:worktree-1',
      conversationId: 'workflow-tab',
      executionId: 'execution-1',
      callId: 'answers/seat-1'
    })
  })

  it('refuses to read logs for an execution the tab no longer shows', async () => {
    const { result } = renderHook(() => useLocalWorkflowController(tab, true))
    await expect(result.current!.readCall!('execution-2', 'answers/seat-1')).rejects.toThrow(
      /execution changed/
    )
    expect(calls.rpc).not.toHaveBeenCalled()
  })
})
