import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchRequest } from '../../../shared/automations-types'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockSubmitPromptToAgentPty = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockListAutomationRunsForTarget = vi.fn()
const mockRunPrecheck = vi.fn()
const mockCallRuntimeRpc = vi.fn()
const mockCreateWorktree = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockSshNeedsPassphrasePrompt = vi.fn()
const mockSshGetState = vi.fn()
const createdWorktree = {
  id: 'wt-created',
  repoId: 'repo-1',
  displayName: 'Automation worktree',
  path: '/repo/worktree'
}
type TestWorktree = typeof createdWorktree & { linkedWorkItem?: { hubTaskId: string } }
const state = {
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  folderWorkspaces: [] as {
    id: string
    projectGroupId: string
    folderPath: string
    connectionId: string | null
    linkedTask?: { hubTaskId: string }
  }[],
  projectGroups: [],
  agentStatusByPaneKey: {},
  agentLaunchConfigByPaneKey: {} as Record<
    string,
    { launchConfig: { agentEnv: Record<string, string> } }
  >,
  allWorktrees: vi.fn<() => TestWorktree[]>(() => []),
  getKnownWorktreeById: vi.fn<(id: string) => TestWorktree | undefined>(() => undefined),
  createWorktree: mockCreateWorktree
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: vi.fn(() => () => {}) }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))
vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ submitPromptToAgentPty: mockSubmitPromptToAgentPty }))
vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))
vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
}))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: mockListAutomationRunsForTarget
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mockCallRuntimeRpc }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  recordRuntimeTerminalInputForPtyId: vi.fn()
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'request-id' }))

function makeAutomation(overrides: Record<string, unknown>) {
  return {
    id: 'automation-1',
    projectId: 'repo-1',
    prompt: 'run this',
    precheck: null,
    agentId: 'claude',
    workspaceMode: 'existing',
    workspaceId: 'wt-existing',
    reuseSession: false,
    ...overrides
  }
}

async function registerAndDispatch(
  automation: ReturnType<typeof makeAutomation>,
  outputBinding?: AutomationDispatchRequest['outputBinding']
): Promise<void> {
  const { handleAutomationDispatchRequest } = await import('./automation-dispatch-handler')
  await handleAutomationDispatchRequest({
    automation,
    run: {
      id: 'run-1',
      automationId: 'automation-1',
      title: 'Automation',
      scheduledFor: 1,
      trigger: 'scheduled',
      workspaceId: automation.workspaceId,
      workspaceDisplayName: null
    },
    dispatchToken: 'token',
    ...(outputBinding ? { outputBinding } : {})
  } as AutomationDispatchRequest)
}

describe('automation dispatch hub authority', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    state.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    state.folderWorkspaces = []
    state.agentLaunchConfigByPaneKey = {}
    state.allWorktrees.mockReturnValue([])
    state.getKnownWorktreeById.mockReturnValue(undefined)
    mockSshNeedsPassphrasePrompt.mockResolvedValue(false)
    mockRunPrecheck.mockResolvedValue(null)
    mockListAutomationRunsForTarget.mockResolvedValue([])
    vi.stubGlobal('window', {
      api: {
        automations: { markDispatchResult: mockMarkDispatchResult, runPrecheck: mockRunPrecheck },
        ssh: { needsPassphrasePrompt: mockSshNeedsPassphrasePrompt, getState: mockSshGetState }
      }
    })
  })

  it('passes the host binding unchanged into a fresh automation launch', async () => {
    state.allWorktrees.mockReturnValue([{ ...createdWorktree, id: 'wt-existing' }])
    mockLaunchAgentBackgroundSession.mockResolvedValueOnce({
      tabId: 'fresh-tab',
      paneKey: 'fresh-pane',
      ptyId: 'fresh-pty',
      terminalOwnership: null
    })
    const outputBinding = Object.freeze({
      automationId: 'automation-1',
      runId: 'run-1',
      token: 'fixture-native-output-binding'
    })

    await registerAndDispatch(makeAutomation({}), outputBinding)

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ automationOutputBinding: outputBinding })
    )
    expect(mockLaunchAgentBackgroundSession.mock.calls[0][0].automationOutputBinding).toBe(
      outputBinding
    )
  })

  it('carries one host binding through every write of a reused-session prompt', async () => {
    state.allWorktrees.mockReturnValue([{ ...createdWorktree, id: 'wt-existing' }])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    mockObserveExistingAutomationSession.mockResolvedValueOnce(() => {})
    mockCallRuntimeRpc.mockResolvedValue({
      send: { accepted: true, handle: 'terminal-1', bytesWritten: 1 }
    })
    const chunks = ['\u001b[200~', 'first prompt chunk', 'last prompt chunk', '\u001b[201~', '\r']
    mockSubmitPromptToAgentPty.mockImplementationOnce(
      async ({ writePty }: { writePty: (text: string) => Promise<boolean> }) => {
        for (const text of chunks) {
          await writePty(text)
        }
        return true
      }
    )
    const outputBinding = Object.freeze({
      automationId: 'automation-1',
      runId: 'run-1',
      token: 'fixture-native-output-binding'
    })

    await registerAndDispatch(makeAutomation({ reuseSession: true }), outputBinding)

    expect(mockCallRuntimeRpc).toHaveBeenCalledTimes(chunks.length)
    mockCallRuntimeRpc.mock.calls.forEach(([target, method, args], index) => {
      expect(target).toEqual({ kind: 'local' })
      expect(method).toBe('automation.sendInput')
      expect(args).toEqual({
        workspaceId: 'wt-existing',
        paneKey: 'reused-pane',
        ptyId: 'reused-pty',
        text: chunks[index],
        automationOutputBinding: outputBinding
      })
      expect(args.automationOutputBinding).toBe(outputBinding)
    })
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
  })

  it.each([
    ['automation_terminal_authority_changed', 0],
    ['terminal_not_writable', 1],
    ['terminal_gone', 1],
    ['connection lost', 0],
    ['connection lost', 1]
  ] as const)(
    'holds a reused prompt after %s on write %s without starting another worker',
    async (message, failedWrite) => {
      state.allWorktrees.mockReturnValue([{ ...createdWorktree, id: 'wt-existing' }])
      mockFindReusableAutomationSession.mockReturnValue({
        tabId: 'reused-tab',
        ptyId: 'reused-pty',
        paneKey: 'reused-pane'
      })
      if (failedWrite > 0) {
        mockCallRuntimeRpc.mockResolvedValueOnce({
          send: { accepted: true, handle: 'terminal-1', bytesWritten: 1 }
        })
      }
      mockCallRuntimeRpc.mockRejectedValueOnce(new Error(message))
      mockSubmitPromptToAgentPty.mockImplementationOnce(
        async ({ writePty }: { writePty: (text: string) => Promise<boolean> }) => {
          await writePty('queued prompt bytes')
          return await writePty('\r')
        }
      )

      await registerAndDispatch(makeAutomation({ reuseSession: true }))

      expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
      expect(mockCallRuntimeRpc).toHaveBeenCalledTimes(failedWrite + 1)
      expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'dispatched',
          launchOutcome: 'unverifiable',
          terminalSessionId: 'reused-tab'
        })
      )
    }
  )

  it('does not retry a reused prompt after acceptance', async () => {
    state.allWorktrees.mockReturnValue([{ ...createdWorktree, id: 'wt-existing' }])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    mockSubmitPromptToAgentPty.mockResolvedValueOnce(true)
    mockObserveExistingAutomationSession.mockRejectedValueOnce(
      new Error('automation_terminal_authority_changed')
    )

    await registerAndDispatch(makeAutomation({ reuseSession: true }))

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'dispatched', launchOutcome: 'unverifiable' })
    )
  })

  it.each(['worktree', 'folder'])(
    'refuses a hub-linked %s before preparation or launch',
    async (kind) => {
      const workspaceId = kind === 'folder' ? 'folder:fw-hub' : 'wt-hub'
      const worktree = { ...createdWorktree, id: workspaceId }
      if (kind === 'folder') {
        state.folderWorkspaces = [
          {
            id: 'fw-hub',
            projectGroupId: 'group-1',
            folderPath: '/repo/worktree',
            connectionId: null,
            linkedTask: { hubTaskId: 'btk_hub' }
          }
        ]
        state.getKnownWorktreeById.mockReturnValue(worktree)
      } else {
        state.allWorktrees.mockReturnValue([
          { ...worktree, linkedWorkItem: { hubTaskId: 'btk_hub' } }
        ])
      }

      await registerAndDispatch(
        makeAutomation({
          workspaceMode: 'existing',
          workspaceId,
          reuseSession: true,
          precheck: { command: 'check' }
        })
      )

      expect(mockRunPrecheck).not.toHaveBeenCalled()
      expect(mockSshNeedsPassphrasePrompt).not.toHaveBeenCalled()
      expect(mockCreateWorktree).not.toHaveBeenCalled()
      expect(mockSubmitPromptToAgentPty).not.toHaveBeenCalled()
      expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
      expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'dispatch_failed',
          error: expect.stringContaining('omnios card btk_hub')
        })
      )
    }
  )

  it('refuses a workspace linked while SSH authentication is pending', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    state.repos[0].connectionId = 'ssh-1'
    mockSshNeedsPassphrasePrompt.mockImplementationOnce(async () => {
      state.allWorktrees.mockReturnValue([
        { ...worktree, linkedWorkItem: { hubTaskId: 'btk_auth' } }
      ])
      return false
    })

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: worktree.id,
        precheck: { command: 'check' }
      })
    )

    expect(mockRunPrecheck).not.toHaveBeenCalled()
    expect(mockSshGetState).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_auth')
      })
    )
  })

  it('refuses a workspace linked while its precheck is pending', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    mockRunPrecheck.mockImplementationOnce(async () => {
      state.allWorktrees.mockReturnValue([
        { ...worktree, linkedWorkItem: { hubTaskId: 'btk_precheck' } }
      ])
      return null
    })

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: worktree.id,
        precheck: { command: 'check' }
      })
    )

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_precheck')
      })
    )
  })

  it('refuses reuse when run-history loading observes a new hub link', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    mockListAutomationRunsForTarget.mockImplementationOnce(async () => {
      state.allWorktrees.mockReturnValue([
        { ...worktree, linkedWorkItem: { hubTaskId: 'btk_reuse' } }
      ])
      return []
    })

    await registerAndDispatch(
      makeAutomation({ workspaceMode: 'existing', workspaceId: worktree.id, reuseSession: true })
    )

    expect(mockSubmitPromptToAgentPty).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_reuse')
      })
    )
  })

  it.each(['Hub card btk_durable owns this run', 'Unknown method automation.sendInput'])(
    'preserves host refusal without a generic write or fresh-launch fallback: %s',
    async (message) => {
      const worktree = { ...createdWorktree, id: 'wt-existing' }
      state.allWorktrees.mockReturnValue([worktree])
      mockFindReusableAutomationSession.mockReturnValue({
        tabId: 'reused-tab',
        ptyId: 'reused-pty',
        paneKey: 'reused-pane'
      })
      mockCallRuntimeRpc.mockRejectedValueOnce(new Error(message))
      mockSubmitPromptToAgentPty.mockImplementationOnce(
        async ({ writePty }: { writePty: (text: string) => Promise<boolean> }) =>
          await writePty('queued prompt bytes')
      )

      await registerAndDispatch(
        makeAutomation({ workspaceMode: 'existing', workspaceId: worktree.id, reuseSession: true })
      )

      expect(mockCallRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'local' },
        'automation.sendInput',
        {
          workspaceId: worktree.id,
          paneKey: 'reused-pane',
          ptyId: 'reused-pty',
          text: 'queued prompt bytes'
        },
        { timeoutMs: 15_000 }
      )
      expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
      expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'dispatched',
          launchOutcome: 'unverifiable',
          error: message
        })
      )
    }
  )

  it('refuses a saved hub-bound session after its workspace link was removed', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    state.agentLaunchConfigByPaneKey['reused-pane'] = {
      launchConfig: { agentEnv: { OMNI_TASK_ID: 'btk_saved' } }
    }

    await registerAndDispatch(
      makeAutomation({ workspaceMode: 'existing', workspaceId: worktree.id, reuseSession: true })
    )

    expect(mockSubmitPromptToAgentPty).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_saved')
      })
    )
  })

  it('rechecks the exact saved session binding inside the queued prompt callback', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    mockSubmitPromptToAgentPty.mockImplementationOnce(
      async ({ beforeWrite }: { beforeWrite: () => void }) => {
        state.agentLaunchConfigByPaneKey['reused-pane'] = {
          launchConfig: { agentEnv: { OMNI_TASK_ID: 'btk_saved_during_queue' } }
        }
        beforeWrite()
        return true
      }
    )

    await registerAndDispatch(
      makeAutomation({ workspaceMode: 'existing', workspaceId: worktree.id, reuseSession: true })
    )

    expect(mockObserveExistingAutomationSession).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_saved_during_queue')
      })
    )
  })

  it('rechecks current hub authority inside the reused prompt write callback', async () => {
    const worktree = { ...createdWorktree, id: 'wt-existing' }
    state.allWorktrees.mockReturnValue([worktree])
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'reused-tab',
      ptyId: 'reused-pty',
      paneKey: 'reused-pane'
    })
    mockSubmitPromptToAgentPty.mockImplementationOnce(
      async ({ beforeWrite }: { beforeWrite: () => void }) => {
        state.allWorktrees.mockReturnValue([
          { ...worktree, linkedWorkItem: { hubTaskId: 'btk_queued' } }
        ])
        beforeWrite()
        return true
      }
    )

    await registerAndDispatch(
      makeAutomation({ workspaceMode: 'existing', workspaceId: worktree.id, reuseSession: true })
    )

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockObserveExistingAutomationSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining('btk_queued')
      })
    )
  })
})
