import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reservePaneConversationLaunch } from './pane-conversation-launch-reservation'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  route: vi.fn(),
  uuid: vi.fn(() => 'id'),
  state: { owner: 'runtime:host', path: '/work', getKnownWorktreeById: vi.fn() }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./browser-uuid', () => ({ createBrowserUuid: mocks.uuid }))
vi.mock('./launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => mocks.state.owner
}))
vi.mock('@/store/terminals/terminal-workspace-routing', () => ({
  resolveTerminalCreationRoute: mocks.route
}))
const input = () => ({
  worktreeId: 'wt',
  submissionId: 'submission',
  navigate: false,
  verify: vi.fn(async () => ({ agent: 'claude' as const, prompt: 'task' })),
  scopeIsCurrent: () => true,
  viewModePreference: 'chat' as const,
  onLaunchResult: vi.fn(),
  onError: vi.fn()
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.owner = 'runtime:host'
  mocks.state.path = '/work'
  mocks.state.getKnownWorktreeById.mockImplementation(() => ({ path: mocks.state.path }))
  mocks.route.mockReset()
})

describe('background pane reservation', () => {
  it('reserves only an intent, preserving the exact submission and grid navigation', async () => {
    const request = input()
    expect(reservePaneConversationLaunch(request)).toBe('submission')
    expect(mocks.launch).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt',
        tabId: 'submission',
        submissionId: 'submission',
        navigate: false,
        viewModePreference: 'chat',
        prompt: 'task'
      })
    )
    expect(request.onLaunchResult).toHaveBeenCalledOnce()
  })
  it('refuses a disconnected owner before verification or tab creation', () => {
    mocks.route.mockImplementation(() => {
      throw new Error('disconnected')
    })
    const request = input()
    expect(() => reservePaneConversationLaunch(request)).toThrow('disconnected')
    expect(request.verify).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it.each(['owner', 'path', 'scope'] as const)(
    'refuses a changed %s after validation',
    async (field) => {
      const request = input()
      request.verify.mockImplementation(async () => {
        if (field === 'owner') {
          mocks.state.owner = 'local'
        }
        if (field === 'path') {
          mocks.state.path = '/other'
        }
        return { agent: 'claude', prompt: 'task' }
      })
      if (field === 'scope') {
        request.scopeIsCurrent = () => false
      }
      reservePaneConversationLaunch(request)
      await Promise.resolve()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(request.onError).toHaveBeenCalledWith(expect.any(Error), false)
    }
  )
  it('distinguishes a failure after launch invocation for reconciliation', async () => {
    mocks.launch.mockImplementationOnce(() => {
      throw new Error('transport lost')
    })
    const request = input()
    reservePaneConversationLaunch(request)
    await Promise.resolve()
    expect(request.onError).toHaveBeenCalledWith(expect.any(Error), true)
  })
})
