// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtySessionWorkRail } from './PtySessionWorkRail'

const mocks = vi.hoisted(() => ({
  entries: {} as Record<string, unknown>,
  transcript: vi.fn(),
  header: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  stopArgs: null as null | { onInterrupted: () => void; paneKey: string; ptyId: string | null },
  canSend: true,
  runtimeEnvironmentId: 'remote-owner',
  exit: null as unknown,
  status: 'ready'
}))
vi.mock('@/store', () => {
  const getState = () => ({
    agentStatusByPaneKey: mocks.entries,
    getKnownWorktreeById: () => ({ id: 'folder', path: '/workspace' })
  })
  return {
    useAppStore: Object.assign(
      (select: (state: ReturnType<typeof getState>) => unknown) => select(getState()),
      { getState }
    )
  }
})
vi.mock('./native-chat-runtime-owner', () => ({
  selectNativeChatRuntimeEnvironmentId: () => mocks.runtimeEnvironmentId
}))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: (args: unknown) => {
    mocks.transcript(args)
    return {
      messages: [
        {
          id: 'retained-turn',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Review the change' }]
        }
      ],
      status: mocks.status,
      readPhase: 'ready'
    }
  }
}))
vi.mock('./use-native-chat-agent-exit', () => ({
  useNativeChatAgentExit: () => ({ record: null, agentExit: mocks.exit })
}))
vi.mock('./use-native-chat-can-send', () => ({ useNativeChatCanSend: () => mocks.canSend }))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({ cancel: vi.fn(), cancelPending: vi.fn() })
}))
vi.mock('./use-native-chat-stop', () => ({
  useNativeChatStop: (args: typeof mocks.stopArgs) => {
    mocks.stopArgs = args
    return {
      stop: () => {
        mocks.stop()
        args?.onInterrupted()
      },
      pending: false,
      unverified: false,
      backgroundStopRequested: false,
      reset: vi.fn()
    }
  }
}))
vi.mock('./NativeChatStopNotice', () => ({ NativeChatStopNotice: () => null }))
vi.mock('./NativeChatAgentExitedNotice', () => ({
  NativeChatAgentExitActions: () => <button>Resume exited session</button>
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: (...args: unknown[]) => mocks.send(...args)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./ConversationWorkHeader', () => ({
  ConversationWorkHeader: (props: { paneKey: string }) => {
    mocks.header(props)
    return <div data-testid="owner">{props.paneKey}</div>
  }
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionReadObservation: () => ({
    state: {
      items: [
        {
          itemId: 'assistant',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Published work' }]
          }
        }
      ],
      submissions: []
    }
  })
}))
const props = {
  worktreeId: 'workspace',
  tabId: 'tab',
  paneKey: 'tab:first',
  ptyId: 'pty-first',
  agent: 'codex' as const,
  visible: true,
  readTerminalScreen: () => 'screen'
}
beforeEach(() => {
  mocks.entries = {
    'tab:first': {
      state: 'done',
      agentType: 'codex',
      providerSession: { id: 'provider-first', transcriptPath: '/owner/first.jsonl' }
    }
  }
  mocks.canSend = true
  mocks.runtimeEnvironmentId = 'remote-owner'
  mocks.status = 'ready'
  mocks.exit = null
  mocks.send.mockReset().mockResolvedValue(true)
  mocks.transcript.mockClear()
  mocks.stop.mockClear()
})
afterEach(cleanup)

describe('PTY shell session work rail', () => {
  it('reads the exact retained transcript on the owning host with Terminal visible', () => {
    render(<PtySessionWorkRail {...props} />)
    expect(mocks.transcript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: 'tab:first',
        sessionId: 'provider-first',
        runtimeEnvironmentId: 'remote-owner',
        enabled: true
      })
    )
  })
  it('rebinds work to the active split and resumes through that split, never its sibling', () => {
    const mounted = render(<PtySessionWorkRail {...props} />)
    mocks.entries['tab:second'] = {
      state: 'done',
      interrupted: true,
      agentType: 'claude',
      providerSession: { id: 'provider-second' }
    }
    mounted.rerender(
      <PtySessionWorkRail {...props} paneKey="tab:second" ptyId="pty-second" agent="claude" />
    )
    expect(screen.getByTestId('owner').textContent).toBe('tab:second')
    fireEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 'pty-second' }))
    mounted.rerender(
      <PtySessionWorkRail {...props} paneKey="tab:shell" ptyId="pty-shell" agent={null} />
    )
    expect(screen.queryByTestId('owner')).toBeNull()
  })
  it('uses the existing Stop path and confirms a resumed send before clearing interrupted state', async () => {
    mocks.status = 'working'
    render(<PtySessionWorkRail {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    expect(mocks.stopArgs).toEqual(
      expect.objectContaining({ paneKey: 'tab:first', ptyId: 'pty-first' })
    )
    mocks.send.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be sent')
    )
    expect(screen.getByRole('button', { name: 'Resume conversation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    )
  })
  it('honors mobile ownership and never resumes work on an exited agent PTY', () => {
    mocks.canSend = false
    mocks.entries['tab:first'] = { ...mocks.entries['tab:first']!, interrupted: true }
    const mounted = render(<PtySessionWorkRail {...props} />)
    expect(
      screen.getByRole('button', { name: 'Resume conversation' }).hasAttribute('disabled')
    ).toBe(true)
    mocks.canSend = true
    mocks.exit = { resumeRecord: {}, worktreeId: 'folder:work' }
    mounted.rerender(<PtySessionWorkRail {...props} />)
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume exited session' })).toBeTruthy()
  })
  it('does not revive an old Stop after a newer turn finishes between renderer updates', () => {
    mocks.status = 'working'
    mocks.entries['tab:first'] = {
      state: 'working',
      stateStartedAt: 10,
      agentType: 'codex',
      providerSession: { id: 'provider-first' }
    }
    const mounted = render(<PtySessionWorkRail {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    expect(screen.getByRole('button', { name: 'Resume conversation' })).toBeTruthy()
    mocks.status = 'ready'
    mocks.entries['tab:first'] = {
      state: 'done',
      stateStartedAt: 40,
      agentType: 'codex',
      providerSession: { id: 'provider-first' },
      stateHistory: [
        { state: 'working', startedAt: 10 },
        { state: 'done', startedAt: 20 },
        { state: 'working', startedAt: 30 }
      ]
    }
    mounted.rerender(<PtySessionWorkRail {...props} />)
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop the agent' })).toBeNull()
  })
  it('clears a confirmed resume without hiding a later interrupted turn', async () => {
    mocks.entries['tab:first'] = {
      state: 'done',
      stateStartedAt: 20,
      interrupted: true,
      agentType: 'codex',
      providerSession: { id: 'provider-first' },
      stateHistory: [{ state: 'working', startedAt: 10 }]
    }
    const mounted = render(<PtySessionWorkRail {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume conversation' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    )
    mocks.entries['tab:first'] = {
      state: 'done',
      stateStartedAt: 40,
      interrupted: true,
      agentType: 'codex',
      providerSession: { id: 'provider-first' },
      stateHistory: [{ state: 'working', startedAt: 30 }]
    }
    mounted.rerender(<PtySessionWorkRail {...props} />)
    expect(screen.getByRole('button', { name: 'Resume conversation' })).toBeTruthy()
  })
  it.each(['pty', 'session', 'runtime'])('keeps Stop state with its %s owner', (owner) => {
    mocks.status = 'working'
    const mounted = render(<PtySessionWorkRail {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    if (owner === 'session') {
      mocks.entries['tab:first'] = {
        state: 'done',
        agentType: 'codex',
        providerSession: { id: 'replacement-session' }
      }
    }
    if (owner === 'runtime') {
      mocks.runtimeEnvironmentId = 'replacement-runtime'
    }
    mounted.rerender(
      <PtySessionWorkRail {...props} ptyId={owner === 'pty' ? 'replacement-pty' : props.ptyId} />
    )
    expect(screen.queryByRole('button', { name: 'Resume conversation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeTruthy()
  })
})

/**
 * Sal, 2026-09-18: "we still have two prompt boxes". The pane has one input — the chat
 * composer on Chat, the terminal on Terminal — and the rail mounts none of its own, on either
 * view and whatever the agent is doing. A prompt for later goes through + Prompt in Up next.
 */
it.each([
  ['idle', 'ready'],
  ['working', 'working']
])('renders no prompt input of its own while the agent is %s', (_state, status) => {
  mocks.status = status
  render(<PtySessionWorkRail {...props} />)
  expect(screen.queryByLabelText('Prompt')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(document.querySelector('[data-work-plan-composer]')).toBeNull()
  // The rail's own controls stay: Stop while working; the work header always.
  expect(screen.queryByRole('button', { name: 'Stop the agent' }) !== null).toBe(
    status === 'working'
  )
  expect(screen.getByTestId('owner')).toBeTruthy()
})

it('offers no Plan Mode, shape selector, Outcome or live chain either', () => {
  render(<PtySessionWorkRail {...props} />)
  expect(screen.queryByText('Plan Mode')).toBeNull()
  expect(screen.queryByLabelText('Work shape')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Outcome' })).toBeNull()
  expect(screen.queryByLabelText('Live chain')).toBeNull()
  expect(document.querySelector('[data-shape]')).toBeNull()
})

it('keeps an unrecognized restored Chat pane header available', () => {
  mocks.entries = {}
  render(<PtySessionWorkRail {...props} agent={null} isChatViewMode />)
  expect(screen.getAllByTestId('owner')).toHaveLength(1)
})

it('keeps the structured header in the rail in both Chat and Terminal mode, so a switch never resizes the pane', () => {
  const structuredRead = { sessionId: 'structured', target: { kind: 'local' as const } }
  const view = render(
    <PtySessionWorkRail {...props} structuredRead={structuredRead} isChatViewMode />
  )
  const expected = expect.objectContaining({
    messages: [
      expect.objectContaining({
        id: 'assistant',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Published work' }]
      })
    ]
  })
  expect(mocks.header).toHaveBeenLastCalledWith(expected)
  expect(screen.getAllByTestId('owner')).toHaveLength(1)
  view.rerender(
    <PtySessionWorkRail {...props} structuredRead={structuredRead} isChatViewMode={false} />
  )
  expect(mocks.header).toHaveBeenLastCalledWith(expected)
  expect(screen.getAllByTestId('owner')).toHaveLength(1)
})
