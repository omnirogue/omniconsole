import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, autoUpdaterMock, nativeUpdaterMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

/**
 * A BrowserWindow stand-in that behaves like Electron's after `close`: `isDestroyed()`
 * flips to true and every webContents call throws "Object has been destroyed".
 */
function createDestroyableWindow() {
  const window = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    isDestroyed: () => boolean
    webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }
    destroy: () => void
  }
  window.destroyed = false
  window.isDestroyed = () => window.destroyed
  window.webContents = {
    isDestroyed: () => window.destroyed,
    send: vi.fn(() => {
      if (window.destroyed) {
        throw new TypeError('Object has been destroyed')
      }
    })
  }
  window.destroy = () => {
    window.destroyed = true
    window.emit('closed')
  }
  return window
}

describe('updater after the main window is destroyed', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    appMock.isPackaged = true
  })

  it('drops updater events instead of sending to a destroyed window', async () => {
    const mainWindow = createDestroyableWindow()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await import('./updater')
    setupAutoUpdater(mainWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    autoUpdaterMock.emit('checking-for-update')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'checking' })
    )

    // Why: the 2026-09-10 crash — MacUpdater emitted after the window closed and the
    // status send threw "Object has been destroyed" as a main_unhandled_rejection.
    mainWindow.destroyed = true
    mainWindow.webContents.send.mockClear()

    expect(() => autoUpdaterMock.emit('update-not-available')).not.toThrow()
    expect(() => autoUpdaterMock.emit('download-progress', { percent: 50 })).not.toThrow()
    expect(() => autoUpdaterMock.emit('error', new Error('feed unreachable'))).not.toThrow()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('removes the updater listeners when the window closes and re-attaches to the next window', async () => {
    const firstWindow = createDestroyableWindow()
    const { setupAutoUpdater } = await import('./updater')
    setupAutoUpdater(firstWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    const registeredEvents = autoUpdaterMock.on.mock.calls.map(([event]) => event)
    expect(registeredEvents).toContain('update-available')

    firstWindow.destroy()

    const removedEvents = autoUpdaterMock.off.mock.calls.map(([event]) => event)
    expect(removedEvents.sort()).toEqual([...registeredEvents].sort())
    if (process.platform === 'darwin') {
      expect(nativeUpdaterMock.off).toHaveBeenCalledWith('update-downloaded', expect.any(Function))
    }

    const secondWindow = createDestroyableWindow()
    autoUpdaterMock.on.mockClear()
    setupAutoUpdater(secondWindow as never, { getLastUpdateCheckAt: () => Date.now() })
    expect(autoUpdaterMock.on.mock.calls.map(([event]) => event)).toEqual(registeredEvents)
  })
})
