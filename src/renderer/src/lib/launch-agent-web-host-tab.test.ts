import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launchAgentInWebHostTab } from './launch-agent-web-host-tab'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  capability: vi.fn(),
  closeTab: vi.fn(),
  setActiveTabType: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: { worktree: [{ id: 'stale-agent', launchAgent: 'codex' }] },
      closeTab: mocks.closeTab,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.capability
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.create,
  createWebRuntimeAgentSessionTerminal: mocks.create,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: mocks.create,
  isWebTerminalSurfaceTabId: () => false
}))

const launch = {
  agent: 'codex' as const,
  worktreeId: 'worktree',
  environmentId: 'remote',
  startupPlan: {
    agent: 'codex' as const,
    launchCommand: 'codex',
    expectedProcess: 'codex',
    launchConfig: { agentArgs: '', agentEnv: {} },
    followupPrompt: null,
    sessionOptions: { effort: 'low' }
  },
  prompt: '',
  promptDelivery: 'auto-submit' as const,
  pastePromptAfterReady: null,
  submitPastedPrompt: false
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capability.mockResolvedValue(true)
  mocks.create.mockResolvedValue({ status: 'created' })
})

describe('paired effort-only launch compatibility', () => {
  it('sends the saved effort to a capable host without a model', async () => {
    await expect(launchAgentInWebHostTab(launch)).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      launched: true
    })
    expect(mocks.capability).toHaveBeenCalledWith(
      'remote',
      'agent-session.effort-only-launch.v1',
      5_000
    )
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        launchPreferences: { effort: 'low' }
      })
    )
  })

  it.each(['unsupported', 'unverified'] as const)(
    'reports a launch gap before creating or pruning tabs on an %s host',
    async (host) => {
      if (host === 'unsupported') {
        mocks.capability.mockResolvedValue(false)
      } else {
        mocks.capability.mockRejectedValue(new Error('status unavailable'))
      }
      await expect(launchAgentInWebHostTab(launch)).resolves.toEqual({
        delivered: false,
        failureNotified: true,
        launched: false
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.closeTab).not.toHaveBeenCalled()
      expect(mocks.setActiveTabType).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining('No agent was started.')
      )
    }
  )

  it('preserves the older host path for a model-bearing actor choice', async () => {
    mocks.capability.mockResolvedValue(false)
    await launchAgentInWebHostTab({
      ...launch,
      startupPlan: {
        ...launch.startupPlan,
        sessionOptions: { model: 'gpt-6.1-sol', effort: 'low' }
      }
    })
    expect(mocks.capability).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        launchPreferences: { model: 'gpt-6.1-sol', effort: 'low' }
      })
    )
  })

  it('preserves unspecified effort on an older host', async () => {
    mocks.capability.mockResolvedValue(false)
    await launchAgentInWebHostTab({
      ...launch,
      startupPlan: { ...launch.startupPlan, sessionOptions: undefined }
    })
    expect(mocks.capability).not.toHaveBeenCalled()
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('launchPreferences')
  })
})
