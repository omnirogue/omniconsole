import { describe, expect, it, vi } from 'vitest'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, setLocalPtyProvider, registerSshPtyProvider } from './pty'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { ptySizes } from './pty/delivery/visibility-state'
import type { PtySpawnResult } from '../providers/types'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-omni-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, mainWindowIpcEvent } = setupPtyIpcSuite()

  // Why: daemon resize is fire-and-forget, so pty:getSize must report the APPLIED size, not the requested one (Claude-Code split-pane desync).
  describe('pty:getSize reports applied size, not requested size', () => {
    function setupProviderWithAppliedSize(args: {
      applied: { cols: number; rows: number } | null
      resize?: (cols: number, rows: number) => void
      getAppliedSize?: (id: string) => Promise<{ cols: number; rows: number } | null>
    }): ReturnType<typeof vi.fn> {
      const write = vi.fn()
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
        write,
        resize: vi.fn(args.resize ?? (() => {})),
        getAppliedSize: vi.fn(args.getAppliedSize ?? (async () => args.applied)),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      return write
    }

    function setupProviderWithTransientAttachFailure(earlyExit = false): ReturnType<typeof vi.fn> {
      const spawn = vi.fn(async (opts: { sessionId?: string }) => {
        if (spawn.mock.calls.length > 1) {
          if (earlyExit) {
            return { id: opts.sessionId ?? 'daemon-pty', exitedBeforeSpawnReply: true as const }
          }
          throw new Error('transport unavailable')
        }
        return { id: opts.sessionId ?? 'daemon-pty' }
      })
      setLocalPtyProvider({
        spawn,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      return spawn
    }

    const resizeListener = (): ((event: unknown, args: unknown) => void) => {
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:resize')
      if (!call) {
        throw new Error('missing pty:resize listener')
      }
      return call[1] as (event: unknown, args: unknown) => void
    }

    function registerGeometrySpawn(
      path: 'renderer' | 'runtime',
      spawn: (opts: { sessionId?: string; cols: number; rows: number }) => Promise<PtySpawnResult>,
      route: { connectionId?: string; degraded?: boolean } = {}
    ) {
      let controller!: {
        spawn: (args: Record<string, unknown>) => Promise<unknown>
        getSize: (id: string) => { cols: number; rows: number } | null
      }
      const provider = {
        spawn,
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null),
        ...(route.degraded ? { routesFreshSpawnsToLocalProvider: true } : {})
      }
      if (route.connectionId) {
        registerSshPtyProvider(route.connectionId, provider as never)
      } else {
        setLocalPtyProvider(provider as never)
      }
      handlers.clear()
      registerPtyHandlers(
        mainWindow as never,
        {
          setPtyController: (next: typeof controller) => {
            controller = next
          },
          registerPty: vi.fn(),
          registerPreAllocatedHandleForPty: vi.fn(),
          createPreAllocatedTerminalHandle: vi.fn(() => null),
          onExternalPtyResize: vi.fn(),
          getDriver: () => ({ kind: 'host' }),
          isResizeSuppressed: () => false
        } as never
      )
      return {
        spawn: (args: Record<string, unknown>) =>
          path === 'runtime'
            ? controller.spawn({ ...args, connectionId: route.connectionId })
            : handlers.get('pty:spawn')!(null, {
                env: {},
                ...args,
                connectionId: route.connectionId
              }),
        size: (id: string) => controller.getSize(id)
      }
    }

    it.each([
      { path: 'renderer', route: {} },
      { path: 'runtime', route: {} },
      { path: 'renderer', route: { degraded: true } },
      { path: 'runtime', route: { degraded: true } },
      { path: 'renderer', route: { connectionId: 'ssh-reattach-ok' } },
      { path: 'runtime', route: { connectionId: 'ssh-reattach-ok' } }
    ] as const)(
      '$path reattach keeps provider geometry unknown without request defaults ($route)',
      async ({ path, route }) => {
        const connectionId = 'connectionId' in route ? route.connectionId : undefined
        const id = connectionId ? toAppSshPtyId(connectionId, 'retained') : `retained-${path}`
        const driver = registerGeometrySpawn(
          path,
          async () => {
            expect(driver.size(id)).toBeNull()
            return { id, isReattach: true, snapshotCols: 256, snapshotRows: 79 }
          },
          route
        )
        await driver.spawn({ sessionId: id, cols: 80, rows: 24 })
        expect(driver.size(id)).toBeNull()
      }
    )

    it.each(['renderer', 'runtime'] as const)(
      '%s reattach retains an existing known grid',
      async (path) => {
        const id = `known-${path}`
        const size = { cols: 256, rows: 79 }
        ptySizes.set(id, size)
        const driver = registerGeometrySpawn(path, async () => {
          expect(driver.size(id)).toBe(size)
          return { id, isReattach: true }
        })
        await driver.spawn({ sessionId: id, cols: 80, rows: 24 })
        expect(driver.size(id)).toBe(size)
      }
    )

    it.each(['renderer', 'runtime'] as const)(
      '%s commit and rollback preserve a same-value real resize during attach',
      async (path) => {
        const id = `resized-${path}`
        const requested = { cols: 80, rows: 24 }
        let resized!: typeof requested
        let fail = false
        const driver = registerGeometrySpawn(path, async () => ({ id }))
        await driver.spawn({ sessionId: id, ...requested })
        const racing = registerGeometrySpawn(path, async () => {
          resizeListener()(mainWindowIpcEvent, { id, ...requested })
          resized = ptySizes.get(id)!
          if (fail) {
            throw new Error('transport unavailable')
          }
          return { id, isReattach: true, appliedSize: { cols: 256, rows: 79 } }
        })
        await racing.spawn({ sessionId: id, ...requested })
        expect(racing.size(id)).toBe(resized)
        expect(racing.size(id)).toEqual(requested)
        fail = true
        await expect(racing.spawn({ sessionId: id, ...requested })).rejects.toThrow(
          'transport unavailable'
        )
        expect(racing.size(id)).toBe(resized)
      }
    )

    it.each(['renderer', 'runtime'] as const)(
      '%s records an initially unknown session that the provider actually creates',
      async (path) => {
        const id = `new-${path}`
        const driver = registerGeometrySpawn(path, async () => {
          expect(driver.size(id)).toBeNull()
          return { id }
        })
        await driver.spawn({ sessionId: id, cols: 120, rows: 40 })
        expect(driver.size(id)).toEqual({ cols: 120, rows: 40 })
      }
    )

    it.each(['renderer', 'runtime'] as const)(
      '%s seeds a known fresh spawn before its provider emits output',
      async (path) => {
        const driver = registerGeometrySpawn(path, async (opts) => {
          expect(driver.size(opts.sessionId!)).toEqual({ cols: 120, rows: 40 })
          return { id: opts.sessionId! }
        })
        await driver.spawn({ cols: 120, rows: 40 })
      }
    )

    it.each([
      { cols: 256, rows: 79 },
      { cols: 0, rows: 79 },
      { cols: 256, rows: Number.NaN },
      { cols: 256.5, rows: 79 }
    ])('uses only valid actual provider reattach dimensions: %j', async (appliedSize) => {
      const id = `actual-reattach-size-${appliedSize.cols}-${appliedSize.rows}`
      const driver = registerGeometrySpawn('runtime', async () => ({
        id,
        isReattach: true,
        appliedSize
      }))
      await driver.spawn({ sessionId: id, cols: 80, rows: 24 })
      expect(driver.size(id)).toEqual(
        appliedSize.cols === 256 && appliedSize.rows === 79 ? appliedSize : null
      )
    })

    it('returns the applied (wide) size after a dropped narrow resize', async () => {
      // The daemon keeps the PTY at its wide spawn size; the narrow resize is silently dropped (fire-and-forget).
      setupProviderWithAppliedSize({ applied: { cols: 200, rows: 50 } })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id

      // Renderer forwards a corrective narrow resize; it is dropped daemon-side.
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      // getSize must surface the applied wide size so the renderer detects drift and re-asserts — NOT requested 80.
      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 200, rows: 50 })
    })
    it('falls back to the requested size when the provider cannot report applied size', async () => {
      // No getAppliedSize (e.g. SSH relay): requested-size cache is the only signal, so getSize returns it.
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: undefined })
      setLocalPtyProvider({
        spawn: vi.fn(async (opts: { sessionId?: string }) => ({
          id: opts.sessionId ?? 'daemon-pty'
        })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 200, rows: 50, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 80, rows: 24 })
    })
    it('preserves provider-owned null so the renderer re-forwards an unverified size', async () => {
      setupProviderWithAppliedSize({ applied: null, getAppliedSize: async () => null })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id
      resizeListener()(mainWindowIpcEvent, { id, cols: 80, rows: 24 })

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toBeNull()
    })
    it('falls back to the requested size when getAppliedSize throws', async () => {
      // A dead daemon/relay must never throw across the IPC boundary or block.
      setupProviderWithAppliedSize({
        applied: null,
        getAppliedSize: async () => {
          throw new Error('daemon unreachable')
        }
      })
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 100, rows: 30, env: {} })
      const id = (spawn as { id: string }).id

      const reported = await handlers.get('pty:getSize')!(null, { id })
      expect(reported).toEqual({ cols: 100, rows: 30 })
    })
    it('preserves cached geometry after a transient renderer attach failure', async () => {
      setupProviderWithTransientAttachFailure()
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const request = { sessionId: 'daemon-existing-size', env: {} }
      await handlers.get('pty:spawn')!(null, { ...request, cols: 200, rows: 50 })

      await expect(
        handlers.get('pty:spawn')!(null, { ...request, cols: 80, rows: 24 })
      ).rejects.toThrow('transport unavailable')

      await expect(handlers.get('pty:getSize')!(null, { id: request.sessionId })).resolves.toEqual({
        cols: 200,
        rows: 50
      })
    })
    it('preserves cached geometry after a transient runtime attach failure', async () => {
      setupProviderWithTransientAttachFailure()
      let controller:
        | {
            spawn: (args: Record<string, unknown>) => Promise<unknown>
            getSize: (id: string) => { cols: number; rows: number } | null
          }
        | undefined
      const runtime = {
        setPtyController: vi.fn((next) => {
          controller = next
        }),
        registerPreAllocatedHandleForPty: vi.fn(),
        registerPty: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const request = { sessionId: 'runtime-existing-size' }
      await controller!.spawn({ ...request, cols: 200, rows: 50 })

      await expect(controller!.spawn({ ...request, cols: 80, rows: 24 })).rejects.toThrow(
        'transport unavailable'
      )

      expect(controller!.getSize(request.sessionId)).toEqual({ cols: 200, rows: 50 })
    })
    it('clears cached geometry when the provider proves the PTY exited before reply', async () => {
      setupProviderWithTransientAttachFailure(true)
      handlers.clear()
      registerPtyHandlers(mainWindow as never)
      const request = { sessionId: 'daemon-exited-before-reply', env: {} }
      await handlers.get('pty:spawn')!(null, { ...request, cols: 200, rows: 50 })

      await expect(
        handlers.get('pty:spawn')!(null, { ...request, cols: 80, rows: 24 })
      ).rejects.toThrow('agent_session_exited_during_start')

      await expect(
        handlers.get('pty:getSize')!(null, { id: request.sessionId })
      ).resolves.toBeNull()
    })
    it('fans out accepted desktop resizes to the runtime after provider resize', async () => {
      const resize = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 120, rows: 30 }, resize })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(resize).toHaveBeenCalledWith(id, 120, 30)
      expect(runtime.onExternalPtyResize).toHaveBeenCalledWith(id, 120, 30)
      expect(resize.mock.invocationCallOrder[0]).toBeLessThan(
        runtime.onExternalPtyResize.mock.invocationCallOrder[0]!
      )
    })
    it('does not fan out rejected desktop resizes to the runtime', async () => {
      setupProviderWithAppliedSize({
        applied: { cols: 80, rows: 24 },
        resize: () => {
          throw new Error('resize rejected')
        }
      })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'host' })),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id

      resizeListener()(mainWindowIpcEvent, { id, cols: 120, rows: 30 })

      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
    it('suppresses the host fit cascade while a remote viewer drives the width', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        // The fix: a PTY with a remote viewer reports true even though driver state stays idle/desktop.
        isRemoteDesktopResizeDriven: vi.fn(() => true),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      // Host's own safeFit tries to widen the viewed PTY back to its window.
      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      // It must not reach the PTY while the viewer owns the width.
      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).toHaveBeenCalledWith(id, 125, 48)
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
    it('lets trusted host activity reclaim remote viewport ownership', () => {
      const claimRemoteDesktopHost = vi.fn().mockResolvedValue(true)
      const runtime = {
        setPtyController: vi.fn(),
        claimRemoteDesktopHost
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const claimListener = call?.[1] as
        | ((event: unknown, args: { id: string; cols: number; rows: number }) => void)
        | undefined
      expect(claimListener).toBeTypeOf('function')

      claimListener?.(mainWindowIpcEvent, { id: 'pty-1', cols: 125, rows: 48 })

      expect(claimRemoteDesktopHost).toHaveBeenCalledWith('pty-1', 125, 48)
    })
    it('does not forward host input when viewport reclaim fails', async () => {
      const write = setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 } })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'idle' })),
        claimRemoteDesktopHost: vi.fn().mockResolvedValue(false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      const claim = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:claimViewport')
      const writeEvent = onMock.mock.calls.find((entry: unknown[]) => entry[0] === 'pty:write')

      claim?.[1](mainWindowIpcEvent, { id, cols: 125, rows: 48 })
      writeEvent?.[1](mainWindowIpcEvent, { id, data: 'x' })
      await Promise.resolve()

      expect(write).not.toHaveBeenCalled()
    })
    it('does not populate the remote reclaim cache when only a phone drives', async () => {
      const resizeSpy = vi.fn()
      setupProviderWithAppliedSize({ applied: { cols: 80, rows: 24 }, resize: resizeSpy })
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        registerPty: vi.fn(),
        getDriver: vi.fn(() => ({ kind: 'mobile', clientId: 'phone-A' })),
        isRemoteDesktopResizeDriven: vi.fn(() => false),
        isResizeSuppressed: vi.fn(() => false),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(),
        recordRemoteDesktopHostReclaimTarget: vi.fn(),
        onExternalPtyResize: vi.fn()
      }
      handlers.clear()
      registerPtyHandlers(mainWindow as never, runtime as never)
      const spawn = await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: {} })
      const id = (spawn as { id: string }).id
      resizeSpy.mockClear()

      resizeListener()(mainWindowIpcEvent, { id, cols: 125, rows: 48 })

      expect(resizeSpy).not.toHaveBeenCalled()
      expect(runtime.recordRemoteDesktopHostReclaimTarget).not.toHaveBeenCalled()
      expect(runtime.onExternalPtyResize).not.toHaveBeenCalled()
    })
  })
})
