import { beforeEach, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { requestOmpSessionExit } from './request-omp-session-exit'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  address: vi.fn(),
  revision: 1,
  cancel: vi.fn(),
  idle: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  hasRuntimeRpcErrorCode: () => false
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => mocks.revision,
  getRuntimeEnvironmentRevision: () => mocks.revision
}))
vi.mock('@/lib/conversation-source-for-pane', () => ({ upNextAddressForPane: mocks.address }))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: mocks.cancel,
  waitForNativeChatPtyIdle: mocks.idle
}))

const leafId = 'd18f152d-0018-4929-9e1d-000000000001'
const source = { kind: 'pty', paneKey: `tab:${leafId}`, worktreeId: 'folder:/workspace' }
const args = {
  tabId: 'tab',
  paneKey: source.paneKey,
  ptyId: toRemoteRuntimePtyId('term-a', 'host-a'),
  sessionId: 'native-a',
  runtimeEnvironmentId: 'host-a',
  assertCurrent: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.revision = 1
  mocks.address.mockReturnValue({ source, owner: { kind: 'environment', environmentId: 'host-a' } })
  mocks.idle.mockResolvedValue(undefined)
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return {
        version: 1,
        durableContinuation: true,
        remoteRuntimeOwnership: 1,
        executionRuntimeId: 'runtime-a',
        placementScope: 'runtime-local',
        ompSessionExit: 1
      }
    }
    if (method === 'terminal.resolvePane') {
      return {
        terminal: {
          handle: 'term-a',
          tabId: 'tab',
          leafId,
          ptyId: 'raw-pty-a',
          worktreeId: source.worktreeId,
          connected: true
        }
      }
    }
    if (method === 'terminal.endOmpSession') {
      return { requested: true }
    }
    throw new Error(`Unexpected method ${method}`)
  })
})

it('sends the native session and host PTY to the captured peer once', async () => {
  await requestOmpSessionExit(args)
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    'terminal.endOmpSession',
    {
      paneKey: source.paneKey,
      worktreeId: source.worktreeId,
      expectedPtyId: 'raw-pty-a',
      expectedProviderSessionId: 'native-a',
      expectedExecutionRuntimeId: 'runtime-a'
    },
    { timeoutMs: 15_000, expectedEnvironmentPairingRevision: 1 }
  )
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(args.ptyId)
  expect(mocks.rpc.mock.calls.every(([target]) => target.environmentId === 'host-a')).toBe(true)
})

it('also fences the local runtime instead of dropping its identity', async () => {
  mocks.address.mockReturnValue({ source, owner: { kind: 'local' } })
  await requestOmpSessionExit({ ...args, runtimeEnvironmentId: null, ptyId: 'raw-pty-a' })
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'local' },
    'terminal.endOmpSession',
    expect.objectContaining({ expectedExecutionRuntimeId: 'runtime-a' }),
    expect.any(Object)
  )
})

it('addresses the host pane while retaining the paired client conversation fence', async () => {
  const tabId = toWebTerminalSurfaceTabId('tab')
  const paneKey = `${tabId}:${leafId}`
  mocks.address.mockReturnValue({
    source: { ...source, paneKey },
    owner: { kind: 'environment', environmentId: 'host-a' }
  })
  await requestOmpSessionExit({ ...args, tabId, paneKey })
  expect(mocks.rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    'terminal.resolvePane',
    {
      paneKey: source.paneKey,
      worktreeId: source.worktreeId,
      expectedExecutionRuntimeId: 'runtime-a'
    },
    expect.any(Object)
  )
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'host-a' },
    'terminal.endOmpSession',
    expect.objectContaining({ paneKey: source.paneKey, expectedProviderSessionId: 'native-a' }),
    expect.any(Object)
  )
  expect(mocks.address).toHaveBeenCalledWith(paneKey, tabId)
})

it.each(['missing', 'other-host', 'structured'])(
  'refuses a %s address before contacting a runtime',
  async (kind) => {
    mocks.address.mockReturnValue(
      kind === 'missing'
        ? null
        : {
            source: { ...source, ...(kind === 'structured' ? { kind: 'structured' } : {}) },
            owner: {
              kind: 'environment',
              environmentId: kind === 'other-host' ? 'host-b' : 'host-a'
            }
          }
    )
    await expect(requestOmpSessionExit(args)).rejects.toThrow('owner is unavailable')
    expect(mocks.rpc).not.toHaveBeenCalled()
  }
)

it('refuses old hosts without an exit or local fallback', async () => {
  mocks.rpc.mockResolvedValueOnce({
    version: 1,
    durableContinuation: true,
    remoteRuntimeOwnership: 1,
    executionRuntimeId: 'runtime-a',
    placementScope: 'runtime-local'
  })
  await expect(requestOmpSessionExit(args)).rejects.toThrow('Update the execution host')
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})

it.each(['handle', 'pty', 'tab', 'leaf', 'disconnected'])(
  'refuses a %s terminal mismatch',
  async (kind) => {
    const original = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation(async (target, method, ...rest) =>
      method === 'terminal.resolvePane'
        ? {
            terminal: {
              handle: kind === 'handle' ? 'term-b' : 'term-a',
              tabId: kind === 'tab' ? 'tab-b' : 'tab',
              leafId: kind === 'leaf' ? 'another-leaf' : leafId,
              ptyId: kind === 'pty' ? null : 'raw-pty-a',
              worktreeId: source.worktreeId,
              connected: kind !== 'disconnected'
            }
          }
        : original(target, method, ...rest)
    )
    await expect(requestOmpSessionExit(args)).rejects.toThrow('terminal changed')
    expect(mocks.rpc.mock.calls.some(([, method]) => method === 'terminal.endOmpSession')).toBe(false)
  }
)

it.each(['pairing', 'address', 'pane'])(
  'ignores %s changes while waiting for pending input',
  async (kind) => {
    mocks.idle.mockImplementationOnce(async () => {
      if (kind === 'pairing') {
        mocks.revision++
      }
      if (kind === 'address') {
        mocks.address.mockReturnValue(null)
      }
      if (kind === 'pane') {
        args.assertCurrent.mockImplementationOnce(() => {
          throw new Error('pane changed')
        })
      }
    })
    await expect(requestOmpSessionExit(args)).rejects.toThrow()
    expect(mocks.rpc.mock.calls.some(([, method]) => method === 'terminal.endOmpSession')).toBe(
      false
    )
  }
)

it('does not turn a lost acknowledgement into a retry', async () => {
  const original = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(async (target, method, ...rest) => {
    if (method === 'terminal.endOmpSession') {
      throw new Error('peer disconnected')
    }
    return original(target, method, ...rest)
  })
  await expect(requestOmpSessionExit(args)).rejects.toThrow('peer disconnected')
  expect(
    mocks.rpc.mock.calls.filter(([, method]) => method === 'terminal.endOmpSession')
  ).toHaveLength(1)
})
