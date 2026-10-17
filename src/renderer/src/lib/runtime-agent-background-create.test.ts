import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(),
  cached: vi.fn(),
  structured: true
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: state.call,
  runtimeEnvironmentSupportsCapability: state.supports
}))
vi.mock('@/runtime/cached-runtime-capability', () => ({
  runtimeEnvironmentHasCachedCapability: state.cached
}))
vi.mock('@/runtime/remote-agent-session-launch', () => ({
  runRemoteAgentSessionLaunch: (args: {
    hostAuthority: () => Promise<unknown>
    legacy: (options: { skipCompatibilityCheck: boolean }) => Promise<unknown>
  }) => (state.structured ? args.hostAuthority() : args.legacy({ skipCompatibilityCheck: true }))
}))
import { createRuntimeAgentBackgroundTerminal } from './runtime-agent-background-create'

const launchCause = {
  trigger: 'automation',
  reference: { automationId: 'auto-1', automationRunId: 'run-1' }
}
const args = {
  environmentId: 'env-1',
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  agent: 'claude',
  launchCause,
  legacy: {
    command: 'claude',
    env: {},
    launchConfig: { agentArgs: '', agentEnv: {} },
    launchToken: 'token'
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  state.structured = true
  state.supports.mockResolvedValue(true)
  state.cached.mockReturnValue(true)
  state.call.mockResolvedValue({ terminal: { handle: 'term-1' } })
})
describe('remote background routine launch provenance', () => {
  it.each([true, false])(
    'carries automation ownership through the structured=%s path once',
    async (structured) => {
      state.structured = structured
      await createRuntimeAgentBackgroundTerminal(args as never)
      expect(state.call).toHaveBeenCalledTimes(1)
      expect(state.call.mock.calls[0][2].launchCause).toEqual(launchCause)
      expect(state.supports).not.toHaveBeenCalled()
      expect(state.cached).toHaveBeenCalledWith('env-1', 'terminal.launch-provenance.v1')
    }
  )
  it('starts without waiting for an optional provenance probe', async () => {
    let release!: (supported: boolean) => void
    state.supports.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const pending = createRuntimeAgentBackgroundTerminal(args as never)
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(state.call).toHaveBeenCalledTimes(1)
    } finally {
      release?.(false)
      await pending
    }
  })
  it.each(['older-host', 'unavailable'])(
    'omits optional metadata for %s without retrying creation',
    async (kind) => {
      if (kind === 'older-host') {
        state.cached.mockReturnValue(false)
      } else {
        state.cached.mockReturnValue(false)
      }
      await createRuntimeAgentBackgroundTerminal(args as never)
      expect(state.call).toHaveBeenCalledTimes(1)
      expect(state.call.mock.calls[0][2]).not.toHaveProperty('launchCause')
    }
  )
})
