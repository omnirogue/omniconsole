/**
 * C3 / plan step 4 on the paired client: the owner's "cannot verify" refusal keeps the pane and
 * parks a retry — it never reads as "Remote terminal was closed." and never creates a terminal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const REFUSAL_MESSAGE =
  'The computer running this session is still loading its sessions (its window is starting or reloading), so it cannot verify this one yet. The session was kept and nothing was started; try again in a moment.'

const refusal = {
  ok: false,
  error: {
    code: 'session_tab_unverifiable',
    message: REFUSAL_MESSAGE,
    data: { retryable: true, reason: 'graph-not-ready' }
  }
}

function snapshot(tabs: Record<string, unknown>[]): unknown {
  return {
    ok: true,
    result: {
      worktree: 'id:wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: tabs.length ? 'host-tab-1::leaf-1' : null,
      activeTabType: tabs.length ? 'terminal' : null,
      tabs
    }
  }
}

const pendingSurface = {
  type: 'terminal',
  id: 'host-tab-1::leaf-1',
  parentTabId: 'host-tab-1',
  leafId: 'leaf-1',
  title: 'Claude',
  isActive: true,
  status: 'pending-handle',
  terminal: null
}

async function connect(): Promise<{ result: unknown; onError: ReturnType<typeof vi.fn> }> {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'leaf-1'
  })
  const onError = vi.fn()
  const result = await transport.connect({ url: '', callbacks: { onError } })
  return { result, onError }
}

describe('remote PTY transport: retryable activation refusals', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('keeps the pane and explains the refusal instead of reporting it closed', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.activate' ? refusal : snapshot([])
    )

    const { result, onError } = await connect()

    expect(result).toBeUndefined()
    expect(onError).toHaveBeenCalledWith(REFUSAL_MESSAGE)
    expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
    for (const method of ['terminal.create', 'terminal.recoverPane']) {
      expect(runtimeCall).not.toHaveBeenCalledWith(expect.objectContaining({ method }))
    }
  })

  it('keeps polling after a refusal, so a click during a short reload opens once the pane is ready', async () => {
    let activations = 0
    let lists = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        activations += 1
        // Why: the first click lands mid-reload; the next one is mounted through the window.
        return activations === 1 ? refusal : snapshot([pendingSurface])
      }
      if (args.method === 'session.tabs.list') {
        lists += 1
        return lists === 1
          ? snapshot([pendingSurface])
          : snapshot([{ ...pendingSurface, status: 'ready', terminal: 'terminal-1' }])
      }
      return { ok: true, result: {} }
    })

    const { result, onError } = await connect()

    expect(activations).toBe(2)
    expect(result).toMatchObject({ id: 'remote:env-1@@terminal-1' })
    expect(onError).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
  })

  it('does not read a later list omission as removal after a retryable refusal', async () => {
    let activations = 0
    let lists = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        activations += 1
        return activations === 1 ? snapshot([pendingSurface]) : refusal
      }
      if (args.method === 'session.tabs.list') {
        lists += 1
        // Why: the owner's unpublished inventory lists nothing, which is not absence proof.
        return lists === 1 ? snapshot([pendingSurface]) : snapshot([])
      }
      return { ok: true, result: {} }
    })

    const { result, onError } = await connect()

    expect(activations).toBe(2)
    expect(result).toBeUndefined()
    expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
  })

  it('still reports confirmed absence (tab_not_found) as closed', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) =>
      args.method === 'session.tabs.activate'
        ? { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
        : { ok: true, result: {} }
    )

    const { result, onError } = await connect()

    expect(result).toBeUndefined()
    expect(onError).toHaveBeenCalledWith('Remote terminal was closed.')
  })
})
