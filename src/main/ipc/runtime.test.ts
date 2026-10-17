import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeAllListenersMock, removeHandlerMock, fromWebContentsMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    onMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    fromWebContentsMock: vi.fn()
  }))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeHandler: removeHandlerMock
  }
}))

import { registerRuntimeHandlers } from './runtime'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../shared/terminal-fit-restore-deadline'
import { ProviderLoginSessions } from '../provider-login-sessions'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { PROVIDER_LOGIN_METHODS } from '../runtime/rpc/methods/provider-login'

function runtimeCallEvent() {
  const mainFrame = {}
  return {
    sender: {
      id: 1,
      mainFrame,
      on: vi.fn(),
      once: vi.fn()
    },
    senderFrame: mainFrame
  }
}

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    removeHandlerMock.mockReset()
    fromWebContentsMock.mockReset()
  })

  it('authenticates desktop provider login through real dispatch without admitting other callers', async () => {
    const signIn = vi.fn<ConstructorParameters<typeof ProviderLoginSessions>[0]>(
      (_request, interaction) =>
        new Promise<void>((_resolve, reject) => {
          interaction.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          })
        })
    )
    const sessions = new ProviderLoginSessions(signIn)
    const runtime = { providerLoginSessions: sessions, getRuntimeId: () => 'runtime-1' }
    registerRuntimeHandlers(runtime as never)
    const call = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')![1]
    const event = runtimeCallEvent()
    try {
      await expect(
        call(
          { ...event, senderFrame: {} },
          { method: 'accounts.login.start', params: { provider: 'claude' } }
        )
      ).rejects.toThrow('current main frame')
      expect(signIn).not.toHaveBeenCalled()
      const started = await call(event, {
        method: 'accounts.login.start',
        params: { provider: 'claude' }
      })
      expect(started.ok).toBe(true)
      expect(started.result.id).toEqual(expect.any(String))
      const id = started.result.id
      const subscribe = handleMock.mock.calls.find(
        ([channel]) => channel === 'runtime:subscribe'
      )![1]
      const send = vi.fn()
      Object.assign(event.sender, { send, isDestroyed: () => false })
      expect(() =>
        subscribe(
          { ...event, senderFrame: {} },
          { subscriptionId: 'spoof', method: 'accounts.login.status', params: { id } }
        )
      ).toThrow('current main frame')
      expect(
        subscribe(event, {
          subscriptionId: 'login-status',
          method: 'accounts.login.status',
          params: { id }
        })
      ).toEqual({ subscribed: true })
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'runtime:subscription:login-status',
          expect.objectContaining({ ok: true, result: expect.objectContaining({ id }) })
        )
      )
      expect(await call(event, { method: 'accounts.login.status', params: { id } })).toMatchObject({
        ok: true,
        result: { id }
      })
      const remote = new RpcDispatcher({
        runtime: runtime as never,
        methods: PROVIDER_LOGIN_METHODS
      })
      for (const method of ['accounts.login.status', 'accounts.login.cancel']) {
        expect(
          await remote.dispatch(
            { id: 'remote', authToken: 'remote-token', method, params: { id } },
            { clientKind: 'runtime', authenticatedCallerFingerprint: 'paired-remote' }
          )
        ).toMatchObject({ ok: false })
      }
      expect(
        await remote.dispatch(
          {
            id: 'anonymous',
            authToken: 'untrusted-token',
            method: 'accounts.login.status',
            params: { id }
          },
          { clientKind: 'runtime' }
        )
      ).toMatchObject({ ok: false })
      expect(await call(event, { method: 'accounts.login.cancel', params: { id } })).toMatchObject({
        ok: true,
        result: { id }
      })
      await vi.waitFor(async () =>
        expect(
          await call(event, { method: 'accounts.login.status', params: { id } })
        ).toMatchObject({ ok: true, result: { id, status: 'cancelled' } })
      )
      expect(signIn).toHaveBeenCalledTimes(1)
    } finally {
      sessions.stop()
    }
  })

  it('routes sync requests through the authoritative browser window id', () => {
    const runtime = {
      syncWindowGraph: vi.fn().mockReturnValue({ graphStatus: 'ready' }),
      getStatus: vi.fn().mockReturnValue({ graphStatus: 'unavailable' }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const syncRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    expect(syncRegistration).toBeTruthy()

    fromWebContentsMock.mockReturnValue({ id: 17 })

    const currentMainFrame = {}
    const sender = { mainFrame: currentMainFrame }
    const handler = syncRegistration![1]
    const graph = { tabs: [], leaves: [], rendererGeneration: 'renderer-1' }
    const result = handler({ sender, senderFrame: currentMainFrame }, graph)

    expect(runtime.syncWindowGraph).toHaveBeenCalledWith(17, graph)
    expect(result).toEqual({ graphStatus: 'ready' })
  })

  it('rejects a graph publication queued by a superseded main frame', () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn()
    }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const sender = { mainFrame: { generation: 2 } }
    fromWebContentsMock.mockReturnValue({ id: 17 })

    expect(() =>
      handler({ sender, senderFrame: { generation: 1 } }, { tabs: [], leaves: [] })
    ).toThrow('Runtime graph sync must originate from the current main frame')
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('rejects graph publications without a renderer generation', () => {
    const runtime = { syncWindowGraph: vi.fn() }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const currentMainFrame = {}
    const sender = { mainFrame: currentMainFrame }
    fromWebContentsMock.mockReturnValue({ id: 17 })

    expect(() =>
      handler({ sender, senderFrame: currentMainFrame }, { tabs: [], leaves: [] })
    ).toThrow('Runtime graph sync requires a renderer generation')
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('routes generic local runtime RPC calls through the dispatcher', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        runtimeId: 'runtime-1',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0
      }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    const result = await handler(runtimeCallEvent(), { method: 'status.get' })

    expect(result).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-1', graphStatus: 'ready' },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('registers project group runtime RPC methods for local desktop callers', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      listProjectGroups: vi.fn().mockReturnValue([{ id: 'group-1', name: 'Platform' }])
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    const result = await handler(runtimeCallEvent(), { method: 'projectGroup.list' })

    expect(result).toMatchObject({
      ok: true,
      result: { groups: [{ id: 'group-1', name: 'Platform' }] },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('registers local runtime streaming subscription lifecycle handlers', () => {
    registerRuntimeHandlers({ syncWindowGraph: vi.fn(), getStatus: vi.fn() } as never)

    expect(handleMock.mock.calls.some(([channel]) => channel === 'runtime:subscribe')).toBe(true)
    expect(onMock.mock.calls.some(([channel]) => channel === 'runtime:unsubscribe')).toBe(true)
    expect(removeAllListenersMock).toHaveBeenCalledWith('runtime:unsubscribe')
  })

  it('deduplicates retries while a terminal fit restore is still pending', async () => {
    const finishRestoreByPtyId = new Map<string, (restored: boolean) => void>()
    const reclaimTerminalForDesktop = vi.fn(
      (ptyId: string) =>
        new Promise<boolean>((resolve) => {
          finishRestoreByPtyId.set(ptyId, resolve)
        })
    )
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      reclaimTerminalForDesktop
    }
    registerRuntimeHandlers(runtime as never)
    const restoreRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:restoreTerminalFit'
    )
    expect(restoreRegistration).toBeTruthy()
    const handler = restoreRegistration![1]

    const first = handler({ sender: {} }, { ptyId: 'pty-1' })
    const retry = handler({ sender: {} }, { ptyId: 'pty-1' })
    const otherTerminal = handler({ sender: {} }, { ptyId: 'pty-2' })

    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(2, 'pty-2')
    finishRestoreByPtyId.get('pty-1')?.(true)
    finishRestoreByPtyId.get('pty-2')?.(true)
    await expect(otherTerminal).resolves.toEqual({ restored: true })
    await expect(first).resolves.toEqual({ restored: true })
    await expect(retry).resolves.toEqual({ restored: true })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)

    const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-1' })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(3)
    finishRestoreByPtyId.get('pty-1')?.(false)
    await expect(afterSettlement).resolves.toEqual({ restored: false })
  })

  it('bounds retries without accumulating reclaim waiters for one PTY', async () => {
    vi.useFakeTimers()
    try {
      let finishRestore!: (restored: boolean) => void
      const reclaimTerminalForDesktop = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishRestore = resolve
          })
      )
      registerRuntimeHandlers({
        syncWindowGraph: vi.fn(),
        getStatus: vi.fn(),
        reclaimTerminalForDesktop
      } as never)
      const handler = handleMock.mock.calls.find(
        ([channel]) => channel === 'runtime:restoreTerminalFit'
      )![1]

      const first = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      await vi.advanceTimersByTimeAsync(TERMINAL_FIT_RESTORE_DEADLINE_MS)
      await expect(first).resolves.toEqual({ restored: false })

      const retry = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(1)
      finishRestore(true)
      await expect(retry).resolves.toEqual({ restored: true })

      const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
      finishRestore(false)
      await expect(afterSettlement).resolves.toEqual({ restored: false })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
