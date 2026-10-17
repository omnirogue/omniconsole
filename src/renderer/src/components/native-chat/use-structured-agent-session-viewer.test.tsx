// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  hold: { processState: 'exited', fallback: false, error: null },
  read: vi.fn(),
  outbox: vi.fn(),
  send: vi.fn(),
  refresh: vi.fn()
}))
vi.mock('./use-structured-agent-session-hold', () => ({
  useStructuredAgentSessionHold: () => mocks.hold
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: (args: unknown) => {
    mocks.read(args)
    return {
      state: {
        fence: 1,
        items: [],
        submissions: [],
        status: 'ready',
        error: null,
        hasOlder: false
      },
      loadingOlder: false,
      loadOlder: vi.fn(),
      refresh: mocks.refresh
    }
  }
}))
vi.mock('./use-structured-agent-session-outbox', () => ({
  useStructuredAgentSessionOutbox: (args: unknown) => {
    mocks.outbox(args)
    return { outbox: [], send: mocks.send, retry: vi.fn(), error: null }
  }
}))
vi.mock('./use-structured-agent-session-mutate', () => ({
  useStructuredAgentSessionMutate: () => ({ mutate: vi.fn() })
}))
vi.mock('./use-structured-agent-session-option-surface', () => ({
  useStructuredAgentSessionOptionSurface: () => ({
    optionSnapshot: [],
    optionSurface: null,
    setStructuredOption: vi.fn()
  })
}))
import { useStructuredAgentSession } from './use-structured-agent-session'
const args = {
  sessionId: 'chat',
  target: { kind: 'local' } as const,
  agent: 'codex',
  isVisible: true,
  viewer: true
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.hold = { processState: 'exited', fallback: false, error: null }
  mocks.call.mockResolvedValue({})
  mocks.send.mockReturnValue(true)
})
afterEach(cleanup)
describe('passive chat controller', () => {
  it('reads paused history while blocking options, outbox dispatch and sending', () => {
    const view = renderHook(() => useStructuredAgentSession(args))
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ isVisible: true }))
    expect(mocks.outbox).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(mocks.call).not.toHaveBeenCalled()
    expect(view.result.current.send('hello', [])).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('waits for the passive hold to restore history before opening its reader', () => {
    mocks.hold.processState = 'checking'
    renderHook(() => useStructuredAgentSession(args))
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ isVisible: false }))
  })
  it('refreshes the reader and enables writes after confirmed Resume', async () => {
    const view = renderHook(() => useStructuredAgentSession(args))
    act(() => {
      mocks.hold = { processState: 'live', fallback: false, error: null }
      view.rerender()
    })
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(args.target, 'agentSession.options', {
        sessionId: 'chat'
      })
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(view.result.current.send('hello', [])).toBe(true)
    expect(mocks.outbox.mock.calls.at(-1)?.[0].enabled).toBe(true)
  })
  it('blocks writes while unreachable and when hidden', () => {
    mocks.hold.processState = 'unverifiable'
    const view = renderHook(({ isVisible }) => useStructuredAgentSession({ ...args, isVisible }), {
      initialProps: { isVisible: true }
    })
    expect(view.result.current.writable).toBe(false)
    mocks.hold.processState = 'live'
    view.rerender({ isVisible: false })
    expect(view.result.current.writable).toBe(false)
    expect(mocks.read.mock.calls.at(-1)?.[0].isVisible).toBe(false)
  })
  it('preserves legacy and setting-off full-page sending behavior', () => {
    mocks.hold = { processState: 'unverifiable', fallback: true, error: null }
    const view = renderHook(({ viewer }) => useStructuredAgentSession({ ...args, viewer }), {
      initialProps: { viewer: true }
    })
    expect(view.result.current.writable).toBe(true)
    mocks.hold.fallback = false
    view.rerender({ viewer: false })
    expect(view.result.current.writable).toBe(true)
  })
})
