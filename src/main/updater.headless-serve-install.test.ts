import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appMock,
  autoUpdaterMock,
  nativeUpdaterMock,
  killAllPtyMock,
  recordUpdaterLifecycleMock,
  requestServeUpdateHandoffMock,
  failServeUpdateHandoffMock,
  armExitWatchdogMock,
  resetHandlers
} = vi.hoisted(() => {
  const appHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const updaterHandlers = new Map<string, ((...args: unknown[]) => void)[]>()

  const emit = (
    handlers: Map<string, ((...args: unknown[]) => void)[]>,
    event: string,
    ...args: unknown[]
  ): void => {
    for (const handler of handlers.get(event) ?? []) {
      handler(...args)
    }
  }

  const appMock = {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.51'),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      appHandlers.set(event, [...(appHandlers.get(event) ?? []), handler])
      return appMock
    }),
    emit: (event: string, ...args: unknown[]) => emit(appHandlers, event, ...args),
    quit: vi.fn()
  }

  const autoUpdaterMock = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: true,
    allowPrerelease: false,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      updaterHandlers.set(event, [...(updaterHandlers.get(event) ?? []), handler])
      return autoUpdaterMock
    }),
    emit: (event: string, ...args: unknown[]) => emit(updaterHandlers, event, ...args)
  }

  return {
    appMock,
    autoUpdaterMock,
    nativeUpdaterMock: { on: vi.fn() },
    killAllPtyMock: vi.fn(),
    recordUpdaterLifecycleMock: vi.fn(),
    requestServeUpdateHandoffMock: vi.fn(() => true),
    failServeUpdateHandoffMock: vi.fn(),
    armExitWatchdogMock: vi.fn(),
    resetHandlers: () => {
      appHandlers.clear()
      updaterHandlers.clear()
    }
  }
})

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  autoUpdater: nativeUpdaterMock,
  powerMonitor: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  net: { fetch: vi.fn() }
}))

vi.mock('electron-updater', () => ({ autoUpdater: autoUpdaterMock }))
vi.mock('./electron-updater-loader', () => ({ loadElectronAutoUpdater: () => autoUpdaterMock }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./ipc/pty', () => ({ killAllPty: killAllPtyMock }))
vi.mock('./updater-changelog', () => ({ fetchChangelog: vi.fn().mockResolvedValue(null) }))
vi.mock('./updater-nudge', () => ({
  fetchNudge: vi.fn().mockResolvedValue(null),
  shouldApplyNudge: vi.fn().mockReturnValue(false)
}))
vi.mock('./updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: vi.fn().mockResolvedValue({
    tags: ['v1.0.61'],
    state: 'ready'
  }),
  getReleaseDownloadUrl: vi.fn()
}))
vi.mock('./update-install-exit-watchdog', () => ({
  armUpdateInstallExitWatchdog: armExitWatchdogMock,
  disarmUpdateInstallExitWatchdog: vi.fn()
}))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./serve-update-handoff', () => ({
  failServeUpdateHandoff: failServeUpdateHandoffMock,
  getServeUpdateHandoffFailure: vi.fn(() => null),
  hasServeUpdateSupervisor: vi.fn(() => true),
  requestServeUpdateHandoff: requestServeUpdateHandoffMock
}))

const nativePlatform = process.platform

describe('headless serve update install handoff', () => {
  beforeEach(() => {
    // Default to the non-Mac path; native SDK cases explicitly select macOS.
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.resetModules()
    vi.stubEnv('OMNI_MAC_SIGNED_RELEASE', '1')
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(null)
    autoUpdaterMock.downloadUpdate.mockReset().mockResolvedValue([])
    autoUpdaterMock.quitAndInstall.mockReset()
    autoUpdaterMock.setFeedURL.mockReset()
    autoUpdaterMock.on.mockClear()
    autoUpdaterMock.autoInstallOnAppQuit = false
    autoUpdaterMock.autoRunAppAfterInstall = true
    nativeUpdaterMock.on.mockReset()
    appMock.on.mockClear()
    appMock.quit.mockReset()
    killAllPtyMock.mockReset()
    recordUpdaterLifecycleMock.mockReset()
    requestServeUpdateHandoffMock.mockReset().mockReturnValue(true)
    failServeUpdateHandoffMock.mockReset()
    armExitWatchdogMock.mockReset()
    resetHandlers()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: nativePlatform })
  })

  it('defers install before disconnecting the serving owner or starting session cleanup', async () => {
    const lifecycle: string[] = []
    const pendingInstaller = { version: '1.0.61', staged: true }
    const servingOwner = { version: '1.0.51', connectedClients: 2, verified: true }
    const replacementOwner: { version: string; verified: boolean } | null = null
    const send = vi.fn()
    const beginSessionCleanup = vi.fn(() => lifecycle.push('session-cleanup'))
    const disconnectPairedClients = vi.fn(() => {
      lifecycle.push('paired-clients-disconnected')
      servingOwner.connectedClients = 0
      servingOwner.verified = false
    })

    appMock.on('will-quit', disconnectPairedClients)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => {
        autoUpdaterMock.emit('update-available', { version: pendingInstaller.version })
      })
      return Promise.resolve(null)
    })
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      lifecycle.push('native-quit-and-install')
      appMock.emit('will-quit', { preventDefault: vi.fn() })
    })
    killAllPtyMock.mockImplementation(beginSessionCleanup)

    const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } = await import('./updater')
    setupAutoUpdater(
      { webContents: { send } } as never,
      {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      } as never
    )

    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.emit('update-downloaded', { version: pendingInstaller.version })
    const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
      ([event]) => event === 'update-downloaded'
    )?.[1] as (() => void) | undefined
    nativeReadyHandler?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'downloaded', version: pendingInstaller.version })
    )

    quitAndInstall()
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    const statuses = send.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, status]) => status)
    expect({
      nativeInstallCalls: autoUpdaterMock.quitAndInstall.mock.calls.length,
      pairedClientDisconnects: disconnectPairedClients.mock.calls.length,
      sessionCleanupStarts: beginSessionCleanup.mock.calls.length,
      servingOwner,
      replacementOwner,
      pendingInstaller,
      deferredStatusVisible: statuses.some(
        (status) =>
          status &&
          typeof status === 'object' &&
          'state' in status &&
          status.state === 'error' &&
          'message' in status &&
          typeof status.message === 'string' &&
          status.message.includes('omni serve')
      ),
      deferralDiagnostics: recordUpdaterLifecycleMock.mock.calls.filter(
        ([event]) => event === 'headless_serve_install_deferred'
      ).length,
      lifecycle
    }).toEqual({
      nativeInstallCalls: 0,
      pairedClientDisconnects: 0,
      sessionCleanupStarts: 0,
      servingOwner: { version: '1.0.51', connectedClients: 2, verified: true },
      replacementOwner: null,
      pendingInstaller: { version: '1.0.61', staged: true },
      deferredStatusVisible: true,
      deferralDiagnostics: 1,
      lifecycle: []
    })
  })

  it('blocks staging and install-on-quit while still reporting an available update', async () => {
    const send = vi.fn()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const { checkForUpdatesFromMenu, downloadUpdate, setupAutoUpdater } = await import('./updater')
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'unsupported-headless-serve'
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'available', version: '1.0.61' })
    )

    downloadUpdate()
    downloadUpdate()

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(
      recordUpdaterLifecycleMock.mock.calls.filter(
        ([event, data]) =>
          event === 'headless_serve_install_deferred' &&
          data &&
          typeof data === 'object' &&
          'phase' in data &&
          data.phase === 'download'
      )
    ).toHaveLength(1)
    expect(
      send.mock.calls.filter(
        ([channel, status]) => channel === 'updater:status' && status?.state === 'error'
      )
    ).toHaveLength(1)
  })

  it('hands a supervised install to the serve parent before native quit and cleanup', async () => {
    const lifecycle: string[] = []
    const daemonSession = { alive: true }
    const send = vi.fn()
    const disconnectPairedClients = vi.fn(() => lifecycle.push('paired-clients-disconnected'))
    appMock.on('will-quit', disconnectPairedClients)
    requestServeUpdateHandoffMock.mockImplementation(() => {
      lifecycle.push('handoff-persisted')
      return true
    })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      lifecycle.push('native-quit-and-install')
      appMock.emit('will-quit', { preventDefault: vi.fn() })
    })
    killAllPtyMock.mockImplementation(() => lifecycle.push('in-process-pty-cleanup'))

    const { checkForUpdatesFromMenu, downloadUpdate, quitAndInstall, setupAutoUpdater } =
      await import('./updater')
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'supervised-headless-serve',
      onBeforeQuit: () => {
        lifecycle.push('pre-quit-checkpoint')
      }
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    downloadUpdate()
    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
    const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
      ([event]) => event === 'update-downloaded'
    )?.[1] as (() => void) | undefined
    nativeReadyHandler?.()

    quitAndInstall()
    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)
    quitAndInstall()

    expect(requestServeUpdateHandoffMock).toHaveBeenCalledWith('1.0.61')
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(false)
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledOnce()
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(true, false)
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
    expect(daemonSession).toEqual({ alive: true })
    expect(lifecycle).toEqual([
      'pre-quit-checkpoint',
      'handoff-persisted',
      'native-quit-and-install',
      'paired-clients-disconnected',
      'in-process-pty-cleanup'
    ])
  })

  it.runIf(process.platform === 'darwin').each(['ready', 'error'])(
    'starts real SDK native preparation only after an explicit supervised install: %s',
    async (outcome) => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const { MacUpdater } = await import('electron-updater/out/MacUpdater')
      const nativeBoundary = Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn()
      })
      const sdk = Object.assign(Object.create(MacUpdater.prototype), {
        nativeUpdater: nativeBoundary,
        squirrelDownloadedUpdate: false,
        app: appMock,
        _logger: { debug: vi.fn() }
      })
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        expect(requestServeUpdateHandoffMock).toHaveBeenCalledWith('1.0.61')
        sdk.autoInstallOnAppQuit = autoUpdaterMock.autoInstallOnAppQuit
        sdk.autoRunAppAfterInstall = autoUpdaterMock.autoRunAppAfterInstall
        sdk.quitAndInstall()
      })
      const {
        checkForUpdatesFromMenu,
        downloadUpdate,
        isQuittingForUpdate,
        quitAndInstall,
        setupAutoUpdater
      } = await import('./updater')
      const { isMacInstallerReady } = await import('./updater-mac-install')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'supervised-headless-serve'
      })
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as () => void
      nativeBoundary.on('update-downloaded', nativeReadyHandler)
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      downloadUpdate()
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledOnce()
      // The SDK finishes the ZIP before requesting native preparation when auto-install is off.
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      expect(send).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )
      expect(isMacInstallerReady()).toBe(false)
      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(false)
      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      await vi.advanceTimersByTimeAsync(16_000)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(requestServeUpdateHandoffMock).not.toHaveBeenCalled()
      expect(nativeBoundary.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()

      quitAndInstall()
      quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      quitAndInstall()
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, false)
      expect(requestServeUpdateHandoffMock).toHaveBeenCalledOnce()
      expect(nativeBoundary.checkForUpdates).toHaveBeenCalledOnce()
      expect(isMacInstallerReady()).toBe(false)
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(armExitWatchdogMock).not.toHaveBeenCalled()
      expect(isQuittingForUpdate()).toBe(true)

      if (outcome === 'error') {
        autoUpdaterMock.emit('error', new Error('native verification rejected the update'))
        expect(failServeUpdateHandoffMock).toHaveBeenCalledOnce()
        expect(isQuittingForUpdate()).toBe(false)
        expect(armExitWatchdogMock).not.toHaveBeenCalled()
        expect(appMock.quit).not.toHaveBeenCalled()
        return
      }

      nativeBoundary.emit('update-downloaded')
      expect(isMacInstallerReady()).toBe(true)
      expect(appMock.quit).toHaveBeenCalledOnce()
      expect(nativeBoundary.quitAndInstall).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce()
      expect(armExitWatchdogMock).toHaveBeenCalledOnce()
      nativeReadyHandler()
      autoUpdaterMock.emit('error', new Error('late native error after verified readiness'))
      expect(armExitWatchdogMock).toHaveBeenCalledOnce()
      expect(isQuittingForUpdate()).toBe(true)
      expect(failServeUpdateHandoffMock).not.toHaveBeenCalled()
    }
  )

  it('keeps the serving owner intact when the supervisor handoff cannot be persisted', async () => {
    const send = vi.fn()
    requestServeUpdateHandoffMock.mockReturnValue(false)
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } = await import('./updater')
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'supervised-headless-serve'
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
    const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
      ([event]) => event === 'update-downloaded'
    )?.[1] as (() => void) | undefined
    nativeReadyHandler?.()

    quitAndInstall()
    await vi.advanceTimersByTimeAsync(100)

    expect(requestServeUpdateHandoffMock).toHaveBeenCalledOnce()
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(killAllPtyMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({
        state: 'error',
        message: expect.stringContaining('supervised server restart')
      })
    )
  })

  it.runIf(process.platform === 'darwin')(
    'defers a pre-staged macOS update resumed from the native-ready continuation',
    async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const { deferMacQuitUntilInstallerReady } = await import('./updater-mac-install')
      expect(
        deferMacQuitUntilInstallerReady(
          { state: 'downloading', percent: 100, version: '1.0.61' },
          true,
          () => '1.0.61',
          send
        )
      ).toBe(true)
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as (() => void) | undefined
      nativeReadyHandler?.()
      await vi.advanceTimersByTimeAsync(0)

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'headless_serve_install_deferred',
        { phase: 'install', version: '1.0.61' },
        expect.objectContaining({ level: 'warn' })
      )
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'error', message: expect.stringContaining('omni serve') })
      )
    }
  )

  it.runIf(process.platform === 'darwin')(
    'does not reinterpret an ordinary headless app quit as an update install request',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, setupAutoUpdater } = await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      const preventDefault = vi.fn()
      appMock.emit('before-quit', { preventDefault })
      await vi.advanceTimersByTimeAsync(15_000)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'darwin')(
    'defers before the macOS installer-readiness timeout can quit the serving owner',
    async () => {
      const send = vi.fn()
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(null)
      })

      const { checkForUpdatesFromMenu, quitAndInstall, setupAutoUpdater } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'unsupported-headless-serve'
      })
      checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })

      quitAndInstall()
      await vi.advanceTimersByTimeAsync(15_000)

      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'error', message: expect.stringContaining('omni serve') })
      )
    }
  )

  it('preserves interactive download and install-on-quit behavior', async () => {
    const send = vi.fn()
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
      return Promise.resolve(null)
    })

    const {
      checkForUpdatesFromMenu,
      downloadUpdate,
      getRemoteServerUpdateSupport,
      setupAutoUpdater
    } = await import('./updater')
    setupAutoUpdater({ webContents: { send } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'interactive'
    })
    checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    downloadUpdate()

    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdaterMock.autoRunAppAfterInstall).toBe(true)
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
    if (process.platform === 'darwin') {
      autoUpdaterMock.emit('update-downloaded', { version: '1.0.61' })
      expect(send).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloading', percent: 100 })
      )
      const nativeReadyHandler = nativeUpdaterMock.on.mock.calls.find(
        ([event]) => event === 'update-downloaded'
      )?.[1] as () => void
      nativeReadyHandler()
      expect(send).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'downloaded', version: '1.0.61' })
      )
      expect(armExitWatchdogMock).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'interactive',
      automatic: true,
      reason: 'available'
    })
    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
      'headless_serve_install_deferred',
      expect.anything(),
      expect.anything()
    )
  })

  it('advertises remote update control only for safely restartable installs', async () => {
    const { checkForRemoteServerUpdate, getRemoteServerUpdateSupport, setupAutoUpdater } =
      await import('./updater')
    setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode: 'unsupported-headless-serve'
    })

    expect(getRemoteServerUpdateSupport()).toEqual({
      installMode: 'unsupported-headless-serve',
      automatic: false,
      reason: 'manual-service-update-required'
    })
    expect(() => checkForRemoteServerUpdate('runtime-1')).toThrow('remote_update_manual_required')
  })
})
