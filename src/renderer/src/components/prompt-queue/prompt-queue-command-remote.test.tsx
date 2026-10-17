// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { upNextAddressForPane } from '@/lib/conversation-source-for-pane'
import { upNextFixture } from '../next-action/up-next-fixture'
import { createPromptQueueTerminalInput } from './prompt-queue-terminal-input'
import { usePromptQueueCommand } from './use-prompt-queue-command'
import type { UpNextAddress } from '@/lib/up-next-address'
import type { UpNextView } from '../../../../shared/up-next-types'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  hasRuntimeRpcErrorCode: () => false
}))
vi.mock('@/lib/conversation-source-for-pane', () => ({ upNextAddressForPane: vi.fn() }))
const address: UpNextAddress = {
  source: { kind: 'pty', worktreeId: 'w', paneKey: 'tab:leaf' },
  owner: { kind: 'environment', environmentId: 'a' }
}
let view: UpNextView
beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([{ id: 'a', createdAt: 1 }])
  vi.mocked(upNextAddressForPane).mockReturnValue(address)
  view = { ...upNextFixture(), conversationId: address.source }
  vi.mocked(callRuntimeRpc).mockImplementation(async (target, method) => {
    expect(target).toEqual(address.owner)
    if (method === 'sessionChain.outcomeCapabilities') {
      return {
        version: 1,
        durableContinuation: true,
        executionRuntimeId: 'runtime-a',
        placementScope: 'runtime-local',
        remoteRuntimeOwnership: 1,
        upNextRemoteOwnership: 1
      }
    }
    if (method === 'upNext.append') {
      view = {
        ...view,
        blocks: [
          {
            id: 'draft:remote',
            kind: 'prompt',
            number: '1',
            state: 'draft',
            locked: false,
            text: 'Continue remotely',
            target: { kind: 'current' }
          }
        ]
      }
    }
    return { view }
  })
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  replaceRuntimeEnvironmentRevisions([])
})

function expectRemoteCommit() {
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    address.owner,
    'upNext.commit',
    {
      conversationId: address.source,
      blockIds: ['draft:remote'],
      expectedExecutionRuntimeId: 'runtime-a'
    },
    { timeoutMs: 15000, expectedEnvironmentPairingRevision: 1 }
  )
}

it('queues a typed Terminal /next on its peer and erases only already-forwarded input', async () => {
  const echo = vi.fn()
  const erase = vi.fn()
  const input = createPromptQueueTerminalInput({
    address: () => address,
    hasAgentSession: () => true,
    erase,
    echo
  })
  for (const char of '/next Continue remotely') {
    expect(input(char)).toBe(false)
  }
  expect(input('\r')).toBe(true)
  await waitFor(() => expect(echo).toHaveBeenCalledTimes(1))
  expect(erase).toHaveBeenCalledTimes(1)
  expectRemoteCommit()
})

it('queues a Chat /next through the same peer connection', async () => {
  const setDraft = vi.fn()
  const report = vi.fn()
  const { result } = renderHook(() => usePromptQueueCommand('tab:leaf', 'tab', setDraft, report))
  await act(async () => {
    expect(result.current('/next Continue remotely')).toBe(true)
  })
  await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  expect(setDraft).toHaveBeenCalledWith('')
  expectRemoteCommit()
})

it('resolves the Chat owner at submission and refuses a pane that disappeared', () => {
  const report = vi.fn()
  const { result } = renderHook(() => usePromptQueueCommand('tab:leaf', 'tab', vi.fn(), report))
  vi.mocked(upNextAddressForPane).mockReturnValue(null)
  expect(result.current('/next Continue remotely')).toBe(true)
  expect(report).toHaveBeenCalledWith(expect.stringContaining('not available'))
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})

it('queues an explicit /next command after current work', async () => {
  const setDraft = vi.fn()
  const report = vi.fn()
  const { result } = renderHook(() => usePromptQueueCommand('tab:leaf', 'tab', setDraft, report))
  await act(async () => {
    expect(result.current('/next Continue remotely')).toBe(true)
  })
  await waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  expect(setDraft).toHaveBeenCalledWith('')
  // The fixture's run is busy (header.state 'running'), so the door chooses `after`.
  const appends = vi.mocked(callRuntimeRpc).mock.calls.filter((call) => call[1] === 'upNext.append')
  expect(appends).toHaveLength(1)
  expect(appends[0]![2]).toMatchObject({
    position: 'head',
    draft: { kind: 'prompt', text: 'Continue remotely', when: 'after' }
  })
  expectRemoteCommit()
  expect(report).toHaveBeenCalledWith(expect.stringContaining('queued'))
})

it('chooses now for an explicit /next command into a free agent', async () => {
  view = { ...view, header: { state: 'idle' } }
  const { result } = renderHook(() => usePromptQueueCommand('tab:leaf', 'tab', vi.fn(), vi.fn()))
  await act(async () => {
    expect(result.current('/next Continue remotely')).toBe(true)
  })
  await waitFor(() =>
    expect(
      vi.mocked(callRuntimeRpc).mock.calls.find((call) => call[1] === 'upNext.append')![2]
    ).toMatchObject({ draft: { when: 'now' } })
  )
})

it('ignores ordinary chat text even without an Up next address', () => {
  const setDraft = vi.fn()
  const report = vi.fn()
  const { result } = renderHook(() => usePromptQueueCommand('tab:leaf', 'tab', setDraft, report))
  vi.mocked(upNextAddressForPane).mockReturnValue(null)
  expect(result.current('Continue remotely')).toBe(false)
  expect(result.current('   ')).toBe(false)
  expect(setDraft).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})
