import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PrereleaseFeed from './updater-prerelease-feed'

const { appMock, autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))

vi.mock('electron', () => {
  const electron = moduleFactories.electron()
  return { ...electron, shell: { ...electron.shell, openExternal } }
})
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', async () => {
  const actual = await vi.importActual<typeof PrereleaseFeed>('./updater-prerelease-feed')
  return {
    ...moduleFactories.updaterPrereleaseFeed(),
    getReleaseDownloadUrl: actual.getReleaseDownloadUrl
  }
})
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

describe.runIf(process.platform === 'darwin')('OmniConsole signed Mac update download', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    openExternal.mockReset().mockResolvedValue(undefined)
    appMock.getVersion.mockReturnValue('1.5.2')
    autoUpdaterMock.downloadUpdate.mockResolvedValue([])
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.5.3'], state: 'ready' })
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.5.3' }))
      return Promise.resolve(undefined)
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it.each(['0', '1'])(
    'uses the release build opt-in %s while preserving explicit user download',
    async (flag) => {
      vi.stubEnv('OMNI_MAC_SIGNED_RELEASE', flag)
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } =
        await import('./updater')
      setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://app.omnisi.ai/updates/latest'
      })
      checkForUpdatesFromMenu()
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({
            state: 'available',
            version: '1.5.3'
          })
        )
      )
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://app.omnisi.ai/updates/v1.5.3'
      })
      // autoDownload stays off because the decision is ours, not electron-updater's:
      // a signed release starts the download itself the moment one is available, so the
      // update is ready when the user restarts, while an unsigned build must not download
      // an artifact it could never install.
      expect(autoUpdaterMock.autoDownload).toBe(false)
      if (flag === '1') {
        expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
      } else {
        expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      }
      downloadUpdate()
      if (flag === '1') {
        // Still once: the download already in flight owns it, so asking again is a no-op
        // rather than a second concurrent download of the same artifact.
        expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
        expect(openExternal).not.toHaveBeenCalled()
      } else {
        expect(openExternal).toHaveBeenCalledWith(
          `https://app.omnisi.ai/updates/v1.5.3/OmniConsole-1.5.3-macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
        )
        expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      }
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    }
  )
})
