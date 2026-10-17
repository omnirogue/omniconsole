// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexStopOutcome } from './native-chat-codex-stop'

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  transcriptStop: vi.fn(),
  settings: vi.fn(() => ({ activeRuntimeEnvironmentId: 'owner-a' }))
}))
vi.mock('./native-chat-codex-stop', () => ({ stopNativeChatCodex: mocks.stop }))
vi.mock('./native-chat-transcript-stop', () => ({ stopNativeChatTranscript: mocks.transcriptStop }))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: mocks.settings }))

import { useNativeChatStop } from './use-native-chat-stop'
import { NativeChatStopNotice } from './NativeChatStopNotice'

type StopArgs = Parameters<typeof useNativeChatStop>[0]
function args(): StopArgs {
  return {
    agent: 'codex',
    terminalTabId: 'tab-a',
    paneKey: 'tab-a:leaf-a',
    ptyId: 'pty-a',
    sessionId: 'thread-a',
    readTerminalScreen: () => 'current screen',
    readSnapshot: () => ({ messages: [] }),
    interactiveSend: {
      sendAnswer: vi.fn(),
      sendApproval: vi.fn(),
      sendRaw: vi.fn(),
      cancel: vi.fn(),
      cancelPending: vi.fn()
    },
    onInterrupted: vi.fn()
  }
}
function Control(props: StopArgs) {
  const control = useNativeChatStop(props)
  return (
    <>
      <button onClick={control.stop}>Stop</button>
      <NativeChatStopNotice
        pending={control.pending}
        unverified={control.unverified}
        backgroundStopRequested={control.backgroundStopRequested}
      />
    </>
  )
}
function deferredStop(stop = mocks.stop) {
  let resolve!: (outcome: CodexStopOutcome) => void
  const promise = new Promise<CodexStopOutcome>((done) => {
    resolve = done
  })
  stop.mockReturnValue(promise)
  return resolve
}

describe('useNativeChatStop', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('holds pending UI until provider acknowledgment and ignores duplicate clicks', async () => {
    const props = args()
    const resolve = deferredStop()
    render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    fireEvent.click(screen.getByText('Stop'))
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(props.interactiveSend.cancelPending).toHaveBeenCalledOnce()
    expect(props.interactiveSend.cancel).not.toHaveBeenCalled()
    expect(props.onInterrupted).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Stopping the current turn')
    await act(async () => resolve('background-stop-requested'))
    expect(props.onInterrupted).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe('Stop requested for background tools.')
  })

  it('keeps a visible uncertain result without claiming the turn stopped', async () => {
    const props = args()
    const resolve = deferredStop()
    render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    await act(async () => resolve('unverified'))
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm Stop')
    expect(props.onInterrupted).not.toHaveBeenCalled()
  })

  it.each([
    ['ptyId', 'pty-b'],
    ['terminalTabId', 'tab-b'],
    ['paneKey', 'tab-a:leaf-b'],
    ['sessionId', 'thread-b'],
    ['runtimeEnvironmentId', 'owner-b'],
    ['connectionId', 'ssh-b'],
    ['agent', 'claude']
  ] as const)(
    'cancels pending writes and suppresses late success after %s replacement',
    async (key, value) => {
      const props = args()
      const resolve = deferredStop()
      const rendered = render(<Control {...props} />)
      fireEvent.click(screen.getByText('Stop'))
      const signal = mocks.stop.mock.calls[0]![0].signal as AbortSignal
      const next = { ...props, [key]: value, onInterrupted: vi.fn() }
      rendered.rerender(<Control {...next} />)
      expect(signal.aborted).toBe(true)
      await act(async () => resolve('background-stop-requested'))
      expect(props.onInterrupted).not.toHaveBeenCalled()
      expect(next.onInterrupted).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    }
  )

  it('does not publish stale errors after a session replacement', async () => {
    const props = args()
    const resolve = deferredStop()
    const rendered = render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    rendered.rerender(<Control {...props} sessionId="next-thread" />)
    await act(async () => resolve('unverified'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['background-stop-requested', 'unverified'] as const)(
    'aborts Stop when the provider exits into the same shell PTY and ignores late %s',
    async (outcome) => {
      const props = args()
      const resolve = deferredStop()
      const rendered = render(<Control {...props} />)
      fireEvent.click(screen.getByText('Stop'))
      const operation = mocks.stop.mock.calls[0]![0]
      expect(operation.signal.aborted).toBe(false)
      expect(operation.readTerminalScreen()).toBe('current screen')

      // None of the tab, pane, PTY or provider-session identifiers changes when
      // Codex dies and its parent shell regains the foreground.
      rendered.rerender(<Control {...props} agentExited />)
      expect(operation.signal.aborted).toBe(true)
      expect(operation.readTerminalScreen()).toBeNull()
      fireEvent.click(screen.getByText('Stop'))
      expect(mocks.stop).toHaveBeenCalledOnce()
      await act(async () => resolve(outcome))
      expect(props.onInterrupted).not.toHaveBeenCalled()
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()

      // A later proven live provider can start a new operation, even if it
      // resumed the same thread in the same terminal.
      const next = deferredStop()
      rendered.rerender(<Control {...props} agentExited={false} />)
      fireEvent.click(screen.getByText('Stop'))
      expect(mocks.stop).toHaveBeenCalledTimes(2)
      expect(mocks.stop.mock.calls[1]![0].signal).not.toBe(operation.signal)
      await act(async () => next('interrupted'))
      expect(props.onInterrupted).toHaveBeenCalledOnce()
    }
  )

  it('cancels on unmount and permits a fresh Stop after remounting the same identity', async () => {
    const props = args()
    const first = deferredStop()
    const rendered = render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    const oldSignal = mocks.stop.mock.calls[0]![0].signal as AbortSignal
    rendered.unmount()
    const second = deferredStop()
    render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    expect(oldSignal.aborted).toBe(true)
    expect(mocks.stop).toHaveBeenCalledTimes(2)
    await act(async () => first('background-stop-requested'))
    expect(props.onInterrupted).not.toHaveBeenCalled()
    await act(async () => second('interrupted'))
    expect(props.onInterrupted).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'omp'] as const)(
    'waits for %s interruption evidence while cancelling pending card input',
    async (agent) => {
      const props = { ...args(), agent }
      const resolve = deferredStop(mocks.transcriptStop)
      render(<Control {...props} />)
      fireEvent.click(screen.getByText('Stop'))
      fireEvent.click(screen.getByText('Stop'))
      expect(props.interactiveSend.cancelPending).toHaveBeenCalledOnce()
      expect(props.interactiveSend.cancel).not.toHaveBeenCalled()
      expect(mocks.transcriptStop).toHaveBeenCalledOnce()
      expect(mocks.stop).not.toHaveBeenCalled()
      expect(props.onInterrupted).not.toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toContain('Stopping the current turn')
      await act(async () => resolve('interrupted'))
      expect(props.onInterrupted).toHaveBeenCalledOnce()
      expect(screen.queryByRole('status')).toBeNull()
    }
  )

  it('preserves working state and a visible warning when OMP Stop cannot be verified', async () => {
    const props = { ...args(), agent: 'omp' as const }
    const resolve = deferredStop(mocks.transcriptStop)
    render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    await act(async () => resolve('unverified'))
    expect(props.onInterrupted).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm Stop')
  })

  it.each([
    ['paneKey', 'tab-a:leaf-b'],
    ['ptyId', 'pty-b'],
    ['sessionId', 'thread-b'],
    ['runtimeEnvironmentId', 'owner-b'],
    ['connectionId', 'ssh-b'],
    ['agentExited', true]
  ] as const)('discards an OMP Stop and its late success after %s changes', async (key, value) => {
    const props = { ...args(), agent: 'omp' as const }
    const resolve = deferredStop(mocks.transcriptStop)
    const rendered = render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    const operation = mocks.transcriptStop.mock.calls[0]![0]
    expect(operation.readSnapshot()).toEqual({ messages: [] })
    rendered.rerender(<Control {...props} {...{ [key]: value }} />)
    expect(operation.signal.aborted).toBe(true)
    expect(operation.readSnapshot()).toBeNull()
    await act(async () => resolve('interrupted'))
    expect(props.onInterrupted).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('aborts an OMP Stop on unmount and reads current transcript evidence after ordinary rerenders', async () => {
    const props = { ...args(), agent: 'omp' as const }
    const resolve = deferredStop(mocks.transcriptStop)
    const rendered = render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    const operation = mocks.transcriptStop.mock.calls[0]![0]
    const snapshot = {
      messages: [],
      transcriptLifecycle: { state: 'interrupted' as const, turnId: 'new-boundary', timestamp: 3 }
    }
    rendered.rerender(<Control {...props} readSnapshot={() => snapshot} />)
    expect(operation.readSnapshot()).toBe(snapshot)
    rendered.unmount()
    expect(operation.signal.aborted).toBe(true)
    await act(async () => resolve('interrupted'))
    expect(props.onInterrupted).not.toHaveBeenCalled()
  })

  it('reports owner resolution failure without getting stuck pending', () => {
    const props = args()
    mocks.settings.mockImplementationOnce(() => {
      throw new Error('owner unavailable')
    })
    render(<Control {...props} />)
    fireEvent.click(screen.getByText('Stop'))
    expect(screen.getByRole('alert').textContent).toContain('Could not confirm Stop')
    expect(screen.queryByRole('status')).toBeNull()
    expect(props.onInterrupted).not.toHaveBeenCalled()
  })
})
