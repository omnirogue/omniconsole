// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { workflowView } from './local-workflow-ui.fixtures'
import {
  LOCAL_WORKFLOW_FALLBACK_POLL_MS,
  useLocalWorkflowProjection
} from './use-local-workflow-projection'

const calls = vi.hoisted(() => ({
  rpc: vi.fn(),
  status: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setLocalWorkflowStatus: calls.status }) }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: calls.rpc }))
vi.mock('@/lib/local-workflow-conversation', () => ({
  persistLocalWorkflowConversationAnchor: vi.fn(async () => {})
}))
// Subscribes immediately, as a visible window would, and tears down on unmount.
vi.mock('@/runtime/window-visibility-subscription-parking', () => ({
  installWindowVisibilitySubscriptionParking: (
    specs: { subscribe: (isCurrent: () => boolean) => Promise<{ unsubscribe: () => void }> }[]
  ) => {
    let disposed = false
    let handle: { unsubscribe: () => void } | undefined
    void specs[0]
      .subscribe(() => !disposed)
      .then((next) => {
        handle = next
        if (disposed) {
          next.unsubscribe()
        }
      })
    return () => {
      disposed = true
      handle?.unsubscribe()
    }
  }
}))

const request = {
  worktree: 'local:worktree-1',
  conversationId: 'tab-1',
  preset: 'council' as const
}
let push: (response: RuntimeRpcResponse<unknown>) => void = () => {}

function viewAt(
  sequence: number,
  attempt = 1,
  callState: LocalWorkflowView['calls'][number]['state'] = 'running',
  phase = 'First opinions'
): LocalWorkflowView {
  const base = workflowView()
  return {
    ...base,
    sequence,
    phase,
    calls: base.calls.map((call) => ({
      ...call,
      attempt,
      state: callState,
      stdout: '',
      stderr: ''
    }))
  }
}

function pushed(view: LocalWorkflowView): RuntimeRpcResponse<unknown> {
  return { id: 'watch', ok: true, result: { type: 'view', view }, _meta: { runtimeId: 'local' } }
}

beforeEach(() => {
  calls.subscribe.mockImplementation(async (_args, callback) => {
    push = callback
    return { unsubscribe: calls.unsubscribe }
  })
  Object.assign(window, { api: { runtime: { subscribe: calls.subscribe } } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('pushed local workflow projection', () => {
  it('follows the watch stream, keeps the newest sequence and publishes the tab status', async () => {
    const { result, unmount } = renderHook(() =>
      useLocalWorkflowProjection(request, 'worktree-1', 'execution-1', true)
    )
    await waitFor(() =>
      expect(calls.subscribe).toHaveBeenCalledWith(
        {
          method: 'localWorkflow.watch',
          params: {
            worktree: 'local:worktree-1',
            conversationId: 'tab-1',
            executionId: 'execution-1'
          }
        },
        expect.any(Function)
      )
    )
    act(() => push(pushed(viewAt(5))))
    expect(result.current.view?.sequence).toBe(5)
    act(() => push(pushed(viewAt(4))))
    expect(result.current.view?.sequence).toBe(5)
    expect(calls.status).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'tab-1',
        executionId: 'execution-1',
        preset: 'council',
        state: 'running',
        phase: 'First opinions'
      })
    )
    expect(calls.rpc).not.toHaveBeenCalled()
    unmount()
    expect(calls.unsubscribe).toHaveBeenCalled()
  })

  it('never lets a slower reply at the same sequence replace a pushed live view', async () => {
    const { result } = renderHook(() =>
      useLocalWorkflowProjection(request, 'worktree-1', 'execution-1', true)
    )
    await waitFor(() => expect(calls.subscribe).toHaveBeenCalled())
    act(() => push(pushed(viewAt(5, 1, 'running', 'Peer rankings'))))
    act(() => result.current.accept(viewAt(5, 1, 'running', 'First opinions')))
    expect(result.current.view?.phase).toBe('Peer rankings')
    act(() => push(pushed(viewAt(5, 1, 'running', 'Chairman'))))
    expect(result.current.view?.phase).toBe('Chairman')
    act(() => result.current.accept(viewAt(6, 1, 'completed', 'Chairman')))
    expect(result.current.view?.sequence).toBe(6)
  })

  it('shows a stream error and falls back to a slow poll', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    calls.rpc.mockResolvedValue(viewAt(7))
    const { result } = renderHook(() =>
      useLocalWorkflowProjection(request, 'worktree-1', 'execution-1', true)
    )
    await waitFor(() => expect(calls.subscribe).toHaveBeenCalled())
    act(() =>
      push({ id: 'watch', ok: false, error: { code: 'runtime_error', message: 'Host restarted' } })
    )
    await waitFor(() => expect(result.current.view?.sequence).toBe(7))
    expect(calls.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'localWorkflow.show', {
      worktree: 'local:worktree-1',
      conversationId: 'tab-1',
      executionId: 'execution-1'
    })
    expect(interval).toHaveBeenCalledWith(expect.any(Function), LOCAL_WORKFLOW_FALLBACK_POLL_MS)
    expect(result.current.error).toBeUndefined()
  })

  it('polls when the stream cannot be opened at all', async () => {
    calls.subscribe.mockRejectedValue(new Error('No runtime'))
    calls.rpc.mockResolvedValue(viewAt(3))
    const { result } = renderHook(() =>
      useLocalWorkflowProjection(request, 'worktree-1', 'execution-1', true)
    )
    await waitFor(() => expect(result.current.view?.sequence).toBe(3))
  })

  it('keeps logs read on demand for their attempt, and through a running retry', async () => {
    const { result } = renderHook(() =>
      useLocalWorkflowProjection(request, 'worktree-1', 'execution-1', true)
    )
    await waitFor(() => expect(calls.subscribe).toHaveBeenCalled())
    act(() => push(pushed(viewAt(5, 1, 'failed'))))
    act(() =>
      result.current.attachLogs('answers/seat-1', 1, {
        stdout: 'raw provider output',
        stderr: 'warning',
        outputTruncated: true
      })
    )
    expect(result.current.view?.calls[0]).toMatchObject({
      stdout: 'raw provider output',
      stderr: 'warning',
      outputTruncated: true
    })
    act(() => push(pushed(viewAt(6, 1, 'failed'))))
    expect(result.current.view?.calls[0].stdout).toBe('raw provider output')
    // The retry has no logs of its own yet, so the failed attempt's logs explain it.
    act(() => push(pushed(viewAt(7, 2, 'running'))))
    expect(result.current.view?.calls[0]).toMatchObject({
      stdout: 'raw provider output',
      attempt: 2
    })
    act(() => push(pushed(viewAt(8, 2, 'completed'))))
    expect(result.current.view?.calls[0]).toMatchObject({ stdout: '', attempt: 2 })
  })
})
