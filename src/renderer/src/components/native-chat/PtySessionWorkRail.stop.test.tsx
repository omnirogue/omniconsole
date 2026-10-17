// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage,
  type NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import { PtySessionWorkRail } from './PtySessionWorkRail'

const mocks = vi.hoisted(() => ({
  agent: 'omp' as 'omp' | 'claude',
  runtimeEnvironmentId: 'peer-a',
  connectionId: 'ssh-a',
  sessionId: 'native-a',
  readPhase: 'ready' as 'ready' | 'loading',
  messages: [] as NativeChatMessage[],
  lifecycle: undefined as NativeChatTurnLifecycle | undefined,
  write: vi.fn(),
  cancelQueue: vi.fn(),
  cancelPending: vi.fn(),
  requestExit: vi.fn()
}))
vi.mock('@/store', () => {
  const getState = () => ({
    sleepingAgentSessionsByPaneKey: {},
    agentStatusByPaneKey: {
      'tab:leaf': {
        state: 'working',
        stateStartedAt: 1000,
        agentType: mocks.agent,
        connectionId: mocks.connectionId,
        providerSession: { id: 'native-a' }
      }
    }
  })
  return {
    useAppStore: Object.assign((select: (state: unknown) => unknown) => select(getState()), {
      getState
    })
  }
})
vi.mock('./request-omp-session-exit', () => ({ requestOmpSessionExit: mocks.requestExit }))
vi.mock('./native-chat-runtime-owner', () => ({
  selectNativeChatRuntimeEnvironmentId: () => mocks.runtimeEnvironmentId
}))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => ({
    agent: mocks.agent,
    sessionId: mocks.sessionId,
    readPhase: mocks.readPhase,
    status: 'working',
    messages: mocks.messages,
    transcriptLifecycle: mocks.lifecycle
  })
}))
vi.mock('./use-native-chat-agent-exit', () => ({
  useNativeChatAgentExit: () => ({ record: null, agentExit: null })
}))
vi.mock('./use-native-chat-can-send', () => ({ useNativeChatCanSend: () => true }))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({ cancelPending: mocks.cancelPending })
}))
vi.mock('./native-chat-codex-stop', () => ({ stopNativeChatCodex: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))
vi.mock('@/runtime/runtime-session-input', () => ({
  cancelRuntimeSessionInputVerified: mocks.cancelQueue
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: vi.fn(),
  waitForNativeChatPtyIdle: async () => {}
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({
    activeRuntimeEnvironmentId: mocks.runtimeEnvironmentId
  }),
  submitPromptToAgentPty: vi.fn()
}))
vi.mock('./ConversationWorkHeader', () => ({ ConversationWorkHeader: () => null }))
vi.mock('./NativeChatAgentExitedNotice', () => ({ NativeChatAgentExitActions: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function rail() {
  return (
    <PtySessionWorkRail
      worktreeId="workspace"
      tabId="tab"
      paneKey="tab:leaf"
      ptyId="owned-pty"
      agent={mocks.agent}
      visible
      readTerminalScreen={() => null}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.agent = 'omp'
  mocks.runtimeEnvironmentId = 'peer-a'
  mocks.connectionId = 'ssh-a'
  mocks.sessionId = 'native-a'
  mocks.readPhase = 'ready'
  mocks.messages = [
    {
      id: 'user-a',
      role: 'user',
      source: 'transcript',
      timestamp: 1000,
      blocks: [{ type: 'text', text: 'Continue the work' }]
    }
  ]
  mocks.lifecycle = { state: 'working', turnId: 'user-a', timestamp: 1000 }
  mocks.cancelQueue.mockResolvedValue(true)
  mocks.write.mockResolvedValue(true)
})
afterEach(cleanup)

it('exposes native End session on the shared rail without inventing an exit or Resume', async () => {
  mocks.requestExit.mockImplementation(async ({ assertCurrent }) => assertCurrent())
  render(rail())
  fireEvent.click(screen.getByRole('button', { name: 'End OMP session' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Exit requested'))
  expect(mocks.requestExit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      paneKey: 'tab:leaf',
      ptyId: 'owned-pty',
      sessionId: 'native-a',
      runtimeEnvironmentId: 'peer-a'
    })
  )
  expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
  expect(
    (screen.getByRole('button', { name: 'End OMP session' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(mocks.write).not.toHaveBeenCalled()
})

it('keeps current-turn Stop available when session exit cannot be confirmed', async () => {
  mocks.requestExit.mockRejectedValue(new Error('Execution host needs an update'))
  render(rail())
  fireEvent.click(screen.getByRole('button', { name: 'End OMP session' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('needs an update'))
  expect(
    (screen.getByRole('button', { name: 'Stop the agent' }) as HTMLButtonElement).disabled
  ).toBe(false)
  expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
})

it.each(['omp', 'claude'] as const)(
  'confirms Terminal Stop for %s only after a new provider interruption',
  async (agent) => {
    mocks.agent = agent
    const mounted = render(rail())
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
        { activeRuntimeEnvironmentId: 'peer-a' },
        'owned-pty',
        '\x1b',
        { requireAcceptance: true }
      )
    )
    expect(screen.getByRole('status').textContent).toContain('Stopping the current turn')
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    mocks.messages = [
      ...mocks.messages,
      {
        id: 'interruption-a',
        role: 'system',
        source: 'transcript',
        timestamp: 1200,
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }]
      }
    ]
    mocks.lifecycle = { state: 'interrupted', turnId: 'user-a', timestamp: 1200 }
    mounted.rerender(rail())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume conversation' })).toBeTruthy()
    )
    expect(screen.queryByRole('alert')).toBeNull()
  }
)

it.each(['loading', 'different-session'] as const)(
  'refuses an unverifiable %s transcript before sending input',
  async (condition) => {
    if (condition === 'loading') {
      mocks.readPhase = 'loading'
    } else {
      mocks.sessionId = 'different-session'
    }
    render(rail())
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not confirm Stop')
    )
    expect(mocks.write).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
  }
)

it.each(['runtimeEnvironmentId', 'connectionId'] as const)(
  'ignores a delayed Stop response when %s changes on the same pane',
  async (key) => {
    let resolve!: (accepted: boolean) => void
    mocks.write.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done
      })
    )
    const mounted = render(rail())
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    mocks[key] = 'owner-b'
    mounted.rerender(rail())
    await act(async () => {
      resolve(true)
    })
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  }
)
