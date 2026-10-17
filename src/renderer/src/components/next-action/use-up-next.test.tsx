// @vitest-environment happy-dom
import { UpNextChainView } from './UpNextChain'
import { upNextRefusal } from './up-next-refusal'
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  render,
  screen,
  fireEvent
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextVisibilityContext } from './up-next-visibility'
import { useUpNext } from './use-up-next'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { upNextFixture } from './up-next-fixture'
import { UP_NEXT_REFUSAL_KEYS, UP_NEXT_WRITE_UNAVAILABLE } from '../../../../shared/up-next-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
it('passes the exact source and rereads after refusal without inventing a draft', async () => {
  const view = upNextFixture()
  const rpc = vi.mocked(callRuntimeRpc)
  rpc.mockImplementation(async (_, method) => {
    if (method === 'upNext.list') {
      return { view }
    }
    throw new Error(UP_NEXT_WRITE_UNAVAILABLE)
  })
  const { result } = renderHook(() => useUpNext(view.conversationId as ConversationSource))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    expect(await result.current.append({ kind: 'done' })).toBe(false)
  })
  expect(rpc).toHaveBeenCalledWith({ kind: 'local' }, 'upNext.append', {
    conversationId: view.conversationId,
    draft: { kind: 'done' }
  })
  expect(rpc.mock.calls.filter((call) => call[1] === 'upNext.list')).toHaveLength(2)
  expect(result.current.error).toBe(UP_NEXT_WRITE_UNAVAILABLE)
  expect(result.current.disabled).toBe(false)
  expect(result.current.view?.blocks).toEqual([])
})
it('does not show a successful write until the host read returns', async () => {
  const view = upNextFixture()
  let resolveRead: ((value: unknown) => void) | undefined
  const rpc = vi.mocked(callRuntimeRpc)
  rpc
    .mockResolvedValueOnce({ view })
    .mockResolvedValueOnce({})
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )
  const { result } = renderHook(() => useUpNext(view.conversationId as ConversationSource))
  await waitFor(() => expect(result.current.view).toEqual(view))
  let pending: Promise<boolean>
  act(() => {
    pending = result.current.append({ kind: 'done' })
  })
  await waitFor(() => expect(resolveRead).toBeDefined())
  expect(result.current.view?.blocks).toHaveLength(0)
  expect(result.current.disabled).toBe(true)
  await act(async () => {
    resolveRead!({ view: upNextFixture('done') })
    await pending
  })
  expect(result.current.view?.blocks).toHaveLength(2)
})
it('drops an old conversation response after navigation', async () => {
  const old = upNextFixture()
  const next = { ...old.conversationId, paneKey: 'other' }
  let resolveOld: ((value: unknown) => void) | undefined
  vi.mocked(callRuntimeRpc)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockResolvedValue({ view: { ...old, conversationId: next } })
  const { result, rerender } = renderHook(({ source }) => useUpNext(source), {
    initialProps: { source: old.conversationId as ConversationSource }
  })
  rerender({ source: next as ConversationSource })
  await waitFor(() => expect(result.current.view?.conversationId).toEqual(next))
  await act(async () => {
    resolveOld!({ view: old })
  })
  expect(result.current.view?.conversationId).toEqual(next)
})
it('reports an unavailable read without inventing an empty host view', async () => {
  vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Host disconnected'))
  const { result } = renderHook(() =>
    useUpNext(upNextFixture().conversationId as ConversationSource)
  )
  await waitFor(() => expect(result.current.error).toBe('Host disconnected'))
  expect(result.current.view).toBeNull()
})

it('renders a human refusal in the failure alert', async () => {
  const view = upNextFixture()
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) => {
    if (method === 'upNext.list') {
      return { view }
    }
    throw new Error(UP_NEXT_REFUSAL_KEYS.needsPerson)
  })
  function Chain() {
    return <UpNextChainView controller={useUpNext(view.conversationId as ConversationSource)} />
  }
  render(<Chain />)
  await waitFor(() => expect(screen.getByRole('button', { name: '+ Person' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '+ Person' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Choose the person this goes to.')
  )
  for (const key of Object.values(UP_NEXT_REFUSAL_KEYS)) {
    expect(upNextRefusal(key)).not.toBe('')
    expect(upNextRefusal(key)).not.toContain('upNext.refusal.')
  }
})

// U-6: there is no host write-door flag to be honest about, so a refusal must not close the
// door. The deleted `unavailable` state used to latch on one generic failure and disable the
// whole composer for that conversation; the second write below proves it is really gone.
it('keeps writing after a refused write instead of latching the composer shut', async () => {
  const view = upNextFixture()
  const rpc = vi.mocked(callRuntimeRpc)
  let refuse = true
  rpc.mockImplementation(async (_, method) => {
    if (method === 'upNext.list') {
      return { view }
    }
    if (refuse) {
      throw new Error(UP_NEXT_WRITE_UNAVAILABLE)
    }
    return {}
  })
  const { result } = renderHook(() => useUpNext(view.conversationId as ConversationSource))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    expect(await result.current.append({ kind: 'done' })).toBe(false)
  })
  expect(result.current.disabled).toBe(false)
  refuse = false
  await act(async () => {
    expect(await result.current.append({ kind: 'done' })).toBe(true)
  })
  expect(rpc.mock.calls.filter((call) => call[1] === 'upNext.append')).toHaveLength(2)
  expect(result.current.error).toBeNull()
  expect(result.current.disabled).toBe(false)
})

it('retains the host view while hidden and resumes reads when visible again', async () => {
  vi.useFakeTimers()
  try {
    const view = upNextFixture()
    const rpc = vi.mocked(callRuntimeRpc).mockResolvedValue({ view })
    function Surface({ visible }: { visible: boolean }) {
      return (
        <UpNextVisibilityContext value={visible}>
          <Reading />
        </UpNextVisibilityContext>
      )
    }
    function Reading() {
      const controller = useUpNext(view.conversationId)
      return <span>{controller.view ? 'Loaded host view' : 'Loading'}</span>
    }
    const mounted = render(<Surface visible />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByText('Loaded host view')).toBeTruthy()
    expect(rpc).toHaveBeenCalledTimes(1)
    mounted.rerender(<Surface visible={false} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Loaded host view')).toBeTruthy()
    mounted.rerender(<Surface visible />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('saves When finished during running work without queuing or finishing it', async () => {
  const view = { ...upNextFixture(), finishReady: false }
  const scheduleFinish = vi.fn()
  const rpc = vi.mocked(callRuntimeRpc).mockResolvedValue({ view })
  const { result } = renderHook(() => useUpNext(view.conversationId, undefined, { scheduleFinish }))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    expect(await result.current.setWhenFinished!({ action: 'end' })).toBe(true)
  })
  expect(scheduleFinish).toHaveBeenCalledWith({ action: 'end' }, view.conversationId)
  expect(rpc.mock.calls.every((call) => call[1] === 'upNext.list')).toBe(true)
  expect(result.current.view?.blocks).toHaveLength(0)
  expect(result.current.error).toBeNull()
})

it('refuses an old execution host rather than treating its idle state as completion', async () => {
  const view = upNextFixture()
  const scheduleFinish = vi.fn()
  vi.mocked(callRuntimeRpc).mockResolvedValue({ view })
  const { result } = renderHook(() => useUpNext(view.conversationId, undefined, { scheduleFinish }))
  await waitFor(() => expect(result.current.view).toEqual(view))
  await act(async () => {
    expect(await result.current.setWhenFinished!({ action: 'save' })).toBe(false)
  })
  expect(scheduleFinish).not.toHaveBeenCalled()
  expect(result.current.error).toContain('Update this execution host')
})
