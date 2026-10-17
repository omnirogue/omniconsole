// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { upNextConnection } from './up-next-connection'
import { readUpNext, writeUpNext } from './up-next-client'
import { commitUpNext } from './up-next-commit'
import { upNextFixture } from './up-next-fixture'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  hasRuntimeRpcErrorCode: () => false
}))

const owner = { kind: 'environment', environmentId: 'host-a' } as const
const view = upNextFixture()
const capabilities = {
  version: 1,
  durableContinuation: true,
  executionRuntimeId: 'runtime-a',
  remoteRuntimeOwnership: 1,
  upNextRemoteOwnership: 1,
  placementScope: 'runtime-local'
}

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([
    { id: 'host-a', createdAt: 1 },
    { id: 'host-b', createdAt: 2 }
  ])
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) =>
    method === 'sessionChain.outcomeCapabilities' ? capabilities : { view }
  )
})
afterEach(() => {
  vi.resetAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

it('keeps read, write, commit and their readbacks on the negotiated peer', async () => {
  const connection = upNextConnection(owner)
  const onRead = vi.fn()
  await readUpNext(view.conversationId, connection)
  await writeUpNext(
    view.conversationId,
    'upNext.append',
    { draft: { kind: 'done' } },
    onRead,
    connection
  )
  await commitUpNext(view, {}, onRead, vi.fn(), connection)
  expect(onRead).toHaveBeenCalledTimes(2)
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    owner,
    'upNext.commit',
    {
      conversationId: view.conversationId,
      expectedExecutionRuntimeId: 'runtime-a'
    },
    { timeoutMs: 15000, expectedEnvironmentPairingRevision: 1 }
  )
  for (const [target, method, params] of vi.mocked(callRuntimeRpc).mock.calls) {
    expect(target).toEqual(owner)
    if (method !== 'sessionChain.outcomeCapabilities') {
      expect(params).toMatchObject({ expectedExecutionRuntimeId: 'runtime-a' })
    }
  }
})

it('isolates identical conversation addresses on two execution hosts', async () => {
  vi.mocked(callRuntimeRpc).mockImplementation(async (target, method) => {
    if (target.kind !== 'environment') {
      throw new Error('Unexpected local call')
    }
    return method === 'sessionChain.outcomeCapabilities'
      ? { ...capabilities, executionRuntimeId: target.environmentId }
      : { view }
  })
  for (const environmentId of ['host-a', 'host-b']) {
    const connection = upNextConnection({ kind: 'environment', environmentId })
    await writeUpNext(view.conversationId, 'upNext.discardDrafts', {}, vi.fn(), connection)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId },
      'upNext.discardDrafts',
      { conversationId: view.conversationId, expectedExecutionRuntimeId: environmentId },
      expect.anything()
    )
  }
})

it('refuses an older peer without sending a write or falling back locally', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({ ...capabilities, upNextRemoteOwnership: undefined })
  await expect(
    writeUpNext(view.conversationId, 'upNext.append', {}, vi.fn(), upNextConnection(owner))
  ).rejects.toThrow('Update this execution host')
  expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  expect(vi.mocked(callRuntimeRpc).mock.calls[0]![1]).toBe('sessionChain.outcomeCapabilities')
})

it('rejects a capability reply from a pairing that was replaced while in flight', async () => {
  let answer!: (value: unknown) => void
  vi.mocked(callRuntimeRpc).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  const reading = readUpNext(view.conversationId, upNextConnection(owner))
  const refused = expect(reading).rejects.toThrow('paired execution owner changed')
  replaceRuntimeEnvironmentRevisions([{ id: 'host-a', createdAt: 3 }])
  answer(capabilities)
  await refused
  expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
})

it('does not retarget a pending mutation or publish its late reply after re-pairing', async () => {
  const connection = upNextConnection(owner)
  await readUpNext(view.conversationId, connection)
  let answer!: (value: unknown) => void
  vi.mocked(callRuntimeRpc).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  const onRead = vi.fn()
  const writing = writeUpNext(
    view.conversationId,
    'upNext.remove',
    { blockId: 'b' },
    onRead,
    connection
  )
  await vi.waitFor(() => expect(answer).toBeDefined())
  const refused = expect(writing).rejects.toThrow('paired execution owner changed')
  replaceRuntimeEnvironmentRevisions([{ id: 'host-a', createdAt: 3 }])
  answer({ view })
  await refused
  expect(onRead).not.toHaveBeenCalled()
  expect(vi.mocked(callRuntimeRpc).mock.calls.map((call) => call[1])).toEqual([
    'sessionChain.outcomeCapabilities',
    'upNext.list',
    'upNext.remove'
  ])
})

it('retains host refusals and rereads from the same owner', async () => {
  const connection = upNextConnection(owner)
  await readUpNext(view.conversationId, connection)
  vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('Conversation has finished'))
  const onRead = vi.fn()
  await expect(
    writeUpNext(view.conversationId, 'upNext.append', {}, onRead, connection)
  ).rejects.toThrow('Conversation has finished')
  expect(onRead).toHaveBeenCalledWith(view)
  expect(vi.mocked(callRuntimeRpc).mock.calls.every((call) => call[0].kind === 'environment')).toBe(
    true
  )
})

it.each([
  { kind: 'pty', worktreeId: 'wrong', paneKey: 'p' },
  { kind: 'structured', worktreeId: 'w', paneKey: 'p', sessionId: 'wrong' },
  { kind: 'thread', threadId: 'wrong' }
])('refuses an unrelated conversation readback: %j', async (conversationId) => {
  vi.mocked(callRuntimeRpc).mockImplementation(async (_, method) =>
    method === 'sessionChain.outcomeCapabilities'
      ? capabilities
      : { view: { ...view, conversationId } }
  )
  await expect(readUpNext(view.conversationId, upNextConnection(owner))).rejects.toThrow(
    'different conversation'
  )
})

it('preserves the existing local wire shape without requiring remote capabilities', async () => {
  await readUpNext(view.conversationId)
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, 'upNext.list', {
    conversationId: view.conversationId
  })
})
