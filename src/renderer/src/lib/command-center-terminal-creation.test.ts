import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  remote: vi.fn(),
  active: vi.fn(),
  mount: vi.fn(),
  replace: vi.fn(),
  create: vi.fn(),
  owner: vi.fn(),
  enabled: true
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: { commandCenter: mocks.enabled }, createTab: mocks.create })
  }
}))
vi.mock('@/store/session-grid', () => ({
  useSessionGrid: {
    getState: () => ({
      panes: { pane: { kind: 'view', viewId: 'terminal' } },
      replacePane: mocks.replace
    })
  }
}))
vi.mock('@/store/terminals/terminal-workspace-routing', () => ({
  tryTerminalCreationRoute: mocks.route
}))
vi.mock('./sidebar-session-context', () => ({ sidebarSessionWorkspace: mocks.owner }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.mount
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.remote,
  isWebRuntimeSessionActive: mocks.active
}))
import {
  createCommandCenterTerminal,
  TerminalCreationUnverifiableError
} from './command-center-terminal-creation'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.enabled = true
  mocks.route.mockReturnValue({ runtimeEnvironmentId: null })
  mocks.owner.mockReturnValue({ hostId: 'local', unavailable: false })
  mocks.create.mockReturnValue({ id: 'tab' })
})
describe('explicit command-center terminal creation', () => {
  it('creates one tab without navigation and borrows it through a session pane', async () => {
    await createCommandCenterTerminal('pane', 'wt')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith('wt', undefined, undefined, { activate: false })
    expect(mocks.replace).toHaveBeenCalledWith(
      'pane',
      expect.objectContaining({ kind: 'session', tabId: 'tab', executionHostId: 'local' })
    )
    expect(mocks.mount).toHaveBeenCalledWith({ worktreeId: 'wt', tabIds: ['tab'] })
  })
  it.each(['unresolved', 'disconnected', 'unverifiable'])(
    'refuses %s ownership without local fallback',
    async (reason) => {
      if (reason === 'unresolved') {
        mocks.route.mockReturnValue(null)
      } else if (reason === 'unverifiable') {
        mocks.owner.mockReturnValue({ hostId: null, unavailable: true })
      } else {
        mocks.route.mockReturnValue({ runtimeEnvironmentId: 'peer' })
        mocks.owner.mockReturnValue({ hostId: 'runtime:peer', unavailable: false })
        mocks.active.mockReturnValue(false)
      }
      await expect(createCommandCenterTerminal('pane', 'wt')).rejects.toThrow(
        /unresolved|disconnected|unverifiable/
      )
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.remote).not.toHaveBeenCalled()
    }
  )
  it('creates on the connected execution host without activating another view', async () => {
    mocks.route.mockReturnValue({ runtimeEnvironmentId: 'peer' })
    mocks.owner.mockReturnValue({ hostId: 'runtime:peer', unavailable: false })
    mocks.active.mockReturnValue(true)
    mocks.remote.mockImplementation(async (args) => {
      args.onSessionCreated('peer-tab')
      return { status: 'created' }
    })
    await createCommandCenterTerminal('pane', 'wt')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.remote).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'peer', activate: false, selectWorktree: false })
    )
    expect(mocks.replace).toHaveBeenCalledWith(
      'pane',
      expect.objectContaining({ tabId: 'peer-tab', executionHostId: 'runtime:peer' })
    )
  })
  it('preserves uncertainty after a remote timeout so the chooser cannot offer a blind retry', async () => {
    mocks.route.mockReturnValue({ runtimeEnvironmentId: 'peer' })
    mocks.owner.mockReturnValue({ hostId: 'runtime:peer', unavailable: false })
    mocks.active.mockReturnValue(true)
    mocks.remote.mockResolvedValue({
      status: 'failed',
      message: 'Creation unverifiable',
      creationUnverifiable: true
    })
    await expect(createCommandCenterTerminal('pane', 'wt')).rejects.toBeInstanceOf(
      TerminalCreationUnverifiableError
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('does nothing when disabled', async () => {
    mocks.enabled = false
    await createCommandCenterTerminal('pane', 'wt')
    expect(mocks.route).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
