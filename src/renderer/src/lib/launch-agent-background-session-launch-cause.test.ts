import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness,
  useRemoteAgentBackgroundRuntime
} from '@/lib/agent-background-session-test-state'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockMarkTrusted = vi.fn()
const mockDispatchEvent = vi.fn()
const mockGetAgentLaunchPlatformForRepo = vi.fn<() => NodeJS.Platform>()
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})
let currentStoreState = state

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => currentStoreState,
    subscribe: vi.fn(() => () => {})
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-launch-platform', () => ({
  getAgentLaunchPlatformForRepo: mockGetAgentLaunchPlatformForRepo
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

describe('launchAgentBackgroundSession', () => {
  beforeEach(() => {
    currentStoreState = state
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    resetAgentBackgroundSessionTestHarness({
      state,
      createTab: mockCreateTab,
      closeTab: mockCloseTab,
      getLaunchPlatform: mockGetAgentLaunchPlatformForRepo,
      runtimeCall: mockRuntimeEnvironmentCall,
      runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
      runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
      subscribeToData: mockSubscribeToPtyData,
      subscribeToExit: mockSubscribeToPtyExit,
      setTabLayout: mockSetTabLayout,
      updateTabPtyId: mockUpdateTabPtyId,
      dispatchEvent: mockDispatchEvent,
      kill: mockKill,
      markTrusted: mockMarkTrusted,
      spawn: mockSpawn,
      write: mockWrite
    })
  })

  it('passes automation and run ids as launch attribution', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the routine',
      automationOutputBinding: {
        automationId: 'auto-1',
        runId: 'run-1',
        token: 'private-binding-token'
      }
    })
    expect(
      mockSpawn.mock.calls.map(([args]) => ({
        launchTrigger: args.launchTrigger,
        launchReference: args.launchReference
      }))
    ).toEqual([
      {
        launchTrigger: 'automation',
        launchReference: { automationId: 'auto-1', automationRunId: 'run-1' }
      }
    ])
  })
  it('passes both owner ids to a remote host without exposing the binding token', async () => {
    useRemoteAgentBackgroundRuntime(state)
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the routine',
      automationOutputBinding: {
        automationId: 'auto-1',
        runId: 'run-1',
        token: 'private-binding-token'
      }
    })
    const calls = mockRuntimeEnvironmentCall.mock.calls.filter(
      ([request]) => request.method === 'terminal.createAgentSession'
    )
    expect(calls).toHaveLength(1)
    expect(calls[0][0].params.launchCause).toEqual({
      trigger: 'automation',
      reference: { automationId: 'auto-1', automationRunId: 'run-1' }
    })
    expect(JSON.stringify(calls[0][0].params.launchCause)).not.toContain('private-binding-token')
  })
})
