// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { useUpNext } from './use-up-next'
import { upNextFixture } from './up-next-fixture'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  hasRuntimeRpcErrorCode: () => false
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

const view = upNextFixture()
function prepare() {
  replaceRuntimeEnvironmentRevisions([
    { id: 'a', createdAt: 1 },
    { id: 'b', createdAt: 2 }
  ])
  vi.mocked(callRuntimeRpc).mockImplementation(async (target, method) => {
    if (target.kind !== 'environment') {
      throw new Error('Unexpected local call')
    }
    return method === 'sessionChain.outcomeCapabilities'
      ? {
          version: 1,
          durableContinuation: true,
          executionRuntimeId: target.environmentId,
          remoteRuntimeOwnership: 1,
          upNextRemoteOwnership: 1,
          placementScope: 'runtime-local'
        }
      : { view: { ...view, notation: target.environmentId } }
  })
}

function useRemote(environmentId: string) {
  return useUpNext(view.conversationId, undefined, {}, { kind: 'environment', environmentId })
}

it('drops a late read when only the execution owner changed', async () => {
  prepare()
  const original = vi.mocked(callRuntimeRpc).getMockImplementation()!
  let answer!: (value: unknown) => void
  vi.mocked(callRuntimeRpc).mockImplementation((target, method, params, options) =>
    target.kind === 'environment' && target.environmentId === 'a' && method === 'upNext.list'
      ? new Promise((resolve) => {
          answer = resolve
        })
      : original(target, method, params, options)
  )
  const { result, rerender } = renderHook(({ host }) => useRemote(host), {
    initialProps: { host: 'a' }
  })
  await waitFor(() => expect(answer).toBeDefined())
  rerender({ host: 'b' })
  await waitFor(() => expect(result.current.view?.notation).toBe('b'))
  await act(async () => {
    answer({ view: { ...view, notation: 'a' } })
  })
  expect(result.current.view?.notation).toBe('b')
  await act(async () => {
    await result.current.append({ kind: 'prompt', text: 'On B' })
  })
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'b' },
    'upNext.append',
    expect.objectContaining({ expectedExecutionRuntimeId: 'b' }),
    expect.anything()
  )
})

it('does not unlock the new owner while its write is still pending', async () => {
  prepare()
  const original = vi.mocked(callRuntimeRpc).getMockImplementation()!
  const answers = new Map<string, (value: unknown) => void>()
  vi.mocked(callRuntimeRpc).mockImplementation((target, method, params, options) =>
    target.kind === 'environment' && method === 'upNext.append'
      ? new Promise((resolve) => {
          answers.set(target.environmentId, resolve)
        })
      : original(target, method, params, options)
  )
  const { result, rerender } = renderHook(({ host }) => useRemote(host), {
    initialProps: { host: 'a' }
  })
  await waitFor(() => expect(result.current.view?.notation).toBe('a'))
  let old!: Promise<boolean>
  act(() => {
    old = result.current.append({ kind: 'prompt', text: 'A' })
  })
  await waitFor(() => expect(answers.has('a')).toBe(true))
  rerender({ host: 'b' })
  await waitFor(() => expect(result.current.view?.notation).toBe('b'))
  let current!: Promise<boolean>
  act(() => {
    current = result.current.append({ kind: 'prompt', text: 'B' })
  })
  await waitFor(() => expect(answers.has('b')).toBe(true))
  await act(async () => {
    answers.get('a')!({ view })
    await old
  })
  expect(result.current.disabled).toBe(true)
  await act(async () => {
    expect(await result.current.append({ kind: 'done' })).toBe(false)
  })
  expect(
    vi.mocked(callRuntimeRpc).mock.calls.filter((call) => call[1] === 'upNext.append')
  ).toHaveLength(2)
  await act(async () => {
    answers.get('b')!({ view })
    await current
  })
  expect(result.current.disabled).toBe(false)
  expect(result.current.view?.notation).toBe('b')
})
