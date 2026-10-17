// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  acquire: vi.fn(),
  observe: vi.fn(),
  windowVisible: true,
  onVisibility: () => {}
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { commandCenter: true } })
}))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => mocks.windowVisible,
  subscribeWindowParkVisibility: (listener: () => void) => {
    mocks.onVisibility = listener
    return () => {}
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-viewer-hold', () => ({
  acquireStructuredViewerHold: mocks.acquire,
  observeStructuredViewerProcess: mocks.observe
}))
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
const target = { kind: 'local' } as const
function useViewer(sessionId = 'chat', enabled = true) {
  return useStructuredAgentSessionHold({
    sessionId,
    target,
    surface: 'pane',
    mode: 'viewer',
    enabled
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.windowVisible = true
  mocks.acquire.mockResolvedValue({ processState: 'exited', fallback: false })
  mocks.call.mockResolvedValue({ held: true })
  mocks.observe.mockReturnValue(vi.fn())
})
afterEach(cleanup)
describe('passive viewer lifecycle', () => {
  it('does not request a resume until Resume is pressed, and keeps the viewer passive', async () => {
    const view = renderHook(() => useViewer())
    await waitFor(() => expect(view.result.current.processState).toBe('exited'))
    expect(mocks.call).not.toHaveBeenCalled()
    await act(async () => {
      expect(await view.result.current.resume()).toBe(true)
    })
    expect(view.result.current.processState).toBe('live')
    expect(mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.hold')).toHaveLength(1)
    const held = mocks.call.mock.calls[0]![2]
    expect(held.holderId).not.toBe(mocks.acquire.mock.calls[0]![2])
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.release', held)
    expect(mocks.acquire).toHaveBeenCalledOnce()
  })
  it('releases on hidden pane and window, then reacquires on restore', async () => {
    const view = renderHook(({ enabled }) => useViewer('chat', enabled), {
      initialProps: { enabled: true }
    })
    await waitFor(() => expect(view.result.current.processState).toBe('exited'))
    const holderId = mocks.acquire.mock.calls[0]![2]
    view.rerender({ enabled: false })
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.release', {
        sessionId: 'chat',
        holderId
      })
    )
    view.rerender({ enabled: true })
    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledTimes(2))
    act(() => {
      mocks.windowVisible = false
      mocks.onVisibility()
    })
    await waitFor(() =>
      expect(
        mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.release')
      ).toHaveLength(2)
    )
    act(() => {
      mocks.windowVisible = true
      mocks.onVisibility()
    })
    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledTimes(3))
  })
  it('discards old live proof while a restored viewer hold is pending', async () => {
    mocks.acquire.mockResolvedValueOnce({ processState: 'live', fallback: false })
    const view = renderHook(({ enabled }) => useViewer('chat', enabled), {
      initialProps: { enabled: true }
    })
    await waitFor(() => expect(view.result.current.processState).toBe('live'))
    view.rerender({ enabled: false })
    let confirm: (value: { processState: 'exited'; fallback: false }) => void = () => {}
    mocks.acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        })
    )
    view.rerender({ enabled: true })
    expect(view.result.current.processState).toBe('checking')
    await act(async () => {
      expect(await view.result.current.resume()).toBe(false)
      confirm({ processState: 'exited', fallback: false })
    })
    expect(view.result.current.processState).toBe('exited')
    expect(mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.hold')).toHaveLength(0)
  })
  it('reports unreachable as unverifiable and cannot resume without exit evidence', async () => {
    mocks.acquire.mockRejectedValue(new Error('host unreachable'))
    const view = renderHook(() => useViewer())
    await waitFor(() => expect(view.result.current.processState).toBe('unverifiable'))
    expect(view.result.current.error).toBe('host unreachable')
    await act(async () => {
      expect(await view.result.current.resume()).toBe(false)
    })
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('reports Resume failure instead of claiming a live process', async () => {
    const view = renderHook(() => useViewer())
    await waitFor(() => expect(view.result.current.processState).toBe('exited'))
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.hold'
        ? Promise.reject(new Error('owner disconnected'))
        : Promise.resolve({ released: true })
    )
    await act(async () => {
      expect(await view.result.current.resume()).toBe(false)
    })
    expect(view.result.current.processState).toBe('unverifiable')
    expect(view.result.current.error).toBe('owner disconnected')
  })
  it('does not let a late Resume update another session', async () => {
    let settle: () => void = () => {}
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.hold'
        ? new Promise<void>((resolve) => {
            settle = resolve
          })
        : Promise.resolve()
    )
    const view = renderHook(({ id }) => useViewer(id), { initialProps: { id: 'old' } })
    await waitFor(() => expect(view.result.current.processState).toBe('exited'))
    let resumed: Promise<boolean> = Promise.resolve(false)
    act(() => {
      resumed = view.result.current.resume()
    })
    view.rerender({ id: 'new' })
    await waitFor(() => expect(view.result.current.processState).toBe('exited'))
    await act(async () => {
      settle()
      await resumed
    })
    expect(view.result.current.processState).toBe('exited')
    expect(mocks.acquire).toHaveBeenCalledTimes(2)
  })
  it('observes exits and connection loss without polling or resuming', async () => {
    const view = renderHook(() => useViewer())
    await waitFor(() => expect(mocks.observe).toHaveBeenCalledOnce())
    const change = mocks.observe.mock.calls[0]![2]
    act(() => change('live'))
    expect(view.result.current.processState).toBe('live')
    act(() => change('unverifiable'))
    expect(view.result.current.processState).toBe('unverifiable')
    act(() => change('exited'))
    expect(view.result.current.processState).toBe('exited')
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
