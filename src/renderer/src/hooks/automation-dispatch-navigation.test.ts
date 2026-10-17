import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  markDispatchResult: vi.fn(),
  state: {
    activeView: 'automations',
    activeWorktreeId: 'previous-workspace',
    activeTabId: 'previous-tab',
    activeTabType: 'terminal',
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/automation-workspace-hub-authority', () => ({
  assertAutomationWorkspaceAuthority: vi.fn()
}))
vi.mock('@/lib/automation-thread-resume-launch', () => ({
  launchAutomationAgentSession: mocks.launch
}))
vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({ repo: { id: 'repo-1' }, context: {} }),
  prepareAutomationDispatchWorkspace: async () => ({ id: 'routine-workspace' })
}))
vi.mock('./automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: () => ({
    setThreadResume: vi.fn(),
    observeAgentStatus: vi.fn(),
    providerSessionFields: () => ({}),
    settlePendingAfterDispatch: async () => {},
    cleanupRunObservers: vi.fn()
  })
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activeView = 'automations'
  mocks.state.activeWorktreeId = 'previous-workspace'
  mocks.state.activeTabId = 'previous-tab'
  vi.stubGlobal('window', {
    api: { automations: { markDispatchResult: mocks.markDispatchResult } }
  })
})

afterEach(() => vi.unstubAllGlobals())

it.each(['launch', 'prompt delivery'])(
  'keeps the conversation the user opened while routine %s was pending',
  async (stage) => {
    let finish!: (accepted: boolean) => void
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    mocks.launch.mockImplementation(async () => {
      announceStarted()
      if (stage === 'launch') {
        await pending
      }
      return {
        resume: null,
        result: {
          tabId: 'routine-tab',
          paneKey: 'routine-pane',
          ptyId: 'routine-pty',
          terminalOwnership: { release: vi.fn(), finalize: vi.fn() },
          ...(stage === 'prompt delivery' ? { promptDeliveryResult: pending } : {})
        }
      }
    })
    const dispatch = handleAutomationDispatchRequest({
      automation: makeAutomation(),
      run: makeRun({ status: 'dispatching' }),
      dispatchToken: 'dispatch-token'
    })
    await started
    mocks.state.activeView = 'terminal'
    mocks.state.activeWorktreeId = 'routine-workspace'
    mocks.state.activeTabId = 'user-conversation'
    finish(true)
    await dispatch

    expect(mocks.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatched' })
    )
    expect(mocks.state.setActiveView).not.toHaveBeenCalled()
    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.state.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.state.setActiveTabType).not.toHaveBeenCalled()
  }
)
