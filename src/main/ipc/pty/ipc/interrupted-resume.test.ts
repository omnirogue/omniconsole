import type * as ContinuationModule from '../../../agent-hooks/interrupted-session-continuation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { prepareInterruptedResume } from './interrupted-resume'
// Why: a Claude spawn here must not write this machine's real Claude config.
vi.mock('../../../claude-accounts/claude-diff-panel-pty', () => ({
  keepClaudeDiffPanelClosedForPty: vi.fn()
}))

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  subscribe: vi.fn(),
  teardown: vi.fn(),
  unsubscribe: vi.fn(),
  ptyId: vi.fn(),
  claim: vi.fn(),
  readEvidence: vi.fn(),
  breadcrumb: vi.fn()
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: {
    getStatusSnapshotForPane: mocks.snapshot,
    subscribeEnrichedStatus: mocks.subscribe
  }
}))
vi.mock('../../../agent-hooks/interrupted-session-evidence', () => ({
  readInterruptedStatus: mocks.readEvidence
}))
vi.mock('../../../agent-hooks/interrupted-session-continuation', async (original) => ({
  ...(await original<typeof ContinuationModule>()),
  claimInterruptedTurn: mocks.claim
}))
vi.mock('../../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/profile'
}))
vi.mock('../pane/key-state', () => ({
  getPtyIdForPaneKey: mocks.ptyId,
  registerPaneKeyTeardownListener: mocks.teardown
}))
vi.mock('../../../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: mocks.breadcrumb
}))

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('11111111-1111-4111-8111-222222222222', leafId)
const providerSession = { key: 'session_id' as const, id: 'thread' }
const args: PtySpawnIpcArgs = {
  cols: 80,
  rows: 24,
  tabId: '11111111-1111-4111-8111-222222222222',
  leafId,
  launchAgent: 'claude',
  launchToken: 'replacement',
  resumeProviderSession: providerSession,
  interruptedRestore: true
}
const ready: AgentHookEventPayload = {
  paneKey,
  launchToken: 'replacement',
  connectionId: null,
  providerSession,
  hookEventName: 'SessionStart',
  payload: {
    state: 'done',
    prompt: '',
    agentType: 'claude',
    sessionBoundary: true
  }
}

function fixture(isRunningAgent = true) {
  const send = vi.fn(
    async (_handle: string, _prompt: string, options: { beforeWrite: () => void }) => {
      options.beforeWrite()
      options.beforeWrite()
    }
  )
  const deps = {
    getSettings: () => ({ autoContinueInterruptedSessions: true }),
    runtime: {
      getTerminalProcessIncarnation: () => 'incarnation',
      getTerminalInteractiveWait: vi.fn(async () => null),
      subscribeToPtyExit: vi.fn(() => () => {}),
      getTerminalHandleForPaneKey: () => 'terminal',
      getTerminalAgentStatus: vi.fn(async () => ({
        isRunningAgent,
        status: 'idle'
      })),
      sendTerminalAgentPrompt: send
    }
  } as unknown as PtySpawnIpcDeps
  return { deps, send }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot.mockReturnValue([
    {
      paneKey,
      connectionId: null,
      state: 'working',
      agentType: 'claude',
      providerSession,
      stateStartedAt: 1,
      receivedAt: 2,
      prompt: ''
    }
  ])
  mocks.subscribe.mockReturnValue(mocks.unsubscribe)
  mocks.teardown.mockReturnValue(mocks.unsubscribe)
  mocks.ptyId.mockReturnValue('pty')
  mocks.claim.mockReturnValue(true)
})

describe('interrupted resume spawn wiring', () => {
  it('buffers readiness until spawn commits and claims only once across paste and Enter', async () => {
    const { deps, send } = fixture()
    const pending = prepareInterruptedResume(deps, args)!
    mocks.subscribe.mock.calls[0][0](ready)
    expect(send).not.toHaveBeenCalled()
    pending.commit('pty', true)
    await vi.waitFor(() => expect(mocks.breadcrumb).toHaveBeenCalled())
    expect(send).toHaveBeenCalledTimes(1)
    expect(mocks.claim).toHaveBeenCalledTimes(1)
  })
  it('refuses a failed resume that returned to the shell', async () => {
    const { deps, send } = fixture(false)
    const pending = prepareInterruptedResume(deps, args)!
    pending.commit('pty', true)
    mocks.subscribe.mock.calls[0][0](ready)
    await vi.waitFor(() => expect(mocks.breadcrumb).toHaveBeenCalled())
    expect(send).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })
  it('refuses provider fallback, reattach, and exits reported before commit', () => {
    const { deps, send } = fixture()
    const pending = prepareInterruptedResume(deps, args)!
    mocks.subscribe.mock.calls[0][0](ready)
    pending.commit('pty', false)
    expect(send).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })
  it('does not arm ordinary launches or SSH panes', () => {
    const { deps } = fixture()
    expect(prepareInterruptedResume(deps, { ...args, interruptedRestore: false })).toBeNull()
    expect(prepareInterruptedResume(deps, { ...args, connectionId: 'remote' })).toBeNull()
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe.each(['omp', 'pi', 'opencode'] as const)(
  '%s interrupted spawn prompt fallback',
  (agentType) => {
    function fallbackFixture() {
      vi.useFakeTimers()
      mocks.snapshot.mockReturnValue([
        {
          paneKey,
          connectionId: null,
          state: 'working',
          agentType,
          providerSession,
          stateStartedAt: 1,
          receivedAt: 2,
          prompt: ''
        }
      ])
      const f = fixture()
      return {
        ...f,
        pending: prepareInterruptedResume(f.deps, {
          ...args,
          launchAgent: agentType
        })!
      }
    }

    it('starts only after successful spawn and claims once', async () => {
      const f = fallbackFixture()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).not.toHaveBeenCalled()
      f.pending.commit('pty', true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(mocks.claim).toHaveBeenCalledTimes(1)
    })

    it('never probes a failed spawn', async () => {
      const f = fallbackFixture()
      f.pending.commit('pty', false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.deps.runtime!.getTerminalAgentStatus).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
    })

    it('does not override a live working hook with later idle evidence', async () => {
      const f = fallbackFixture()
      mocks.subscribe.mock.calls[0][0]({
        ...ready,
        hookEventName: 'agent_start',
        payload: { agentType, state: 'working', prompt: '' }
      })
      f.pending.commit('pty', true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).not.toHaveBeenCalled()
      f.pending.dispose()
    })

    it('cancels pending observation on exit', async () => {
      const f = fallbackFixture()
      f.pending.commit('pty', true)
      vi.mocked(f.deps.runtime!.subscribeToPtyExit).mock.calls[0][1]()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).not.toHaveBeenCalled()
    })

    it('honors disabled setting before probing', async () => {
      const f = fallbackFixture()
      f.deps.getSettings = () => ({ autoContinueInterruptedSessions: false }) as never
      f.pending.commit('pty', true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.send).not.toHaveBeenCalled()
      f.pending.dispose()
    })
  }
)
