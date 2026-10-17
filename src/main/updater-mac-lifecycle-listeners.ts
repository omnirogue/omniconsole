import { app, autoUpdater as nativeUpdater } from 'electron'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  consumeMacInstallGuardBypass,
  deferMacQuitUntilInstallerReady,
  handleMacInstallerReady,
  isMacQuitAndInstallInFlight
} from './updater-mac-install'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

export type MacLifecycleListenerContext = {
  commitMacInstallIfReady: () => void
  getCurrentStatus: () => UpdateStatus
  getKnownReleaseUrl: () => string | undefined
  getPendingInstallVersion: () => string
  hasInstallableDownloadedVersion: () => boolean
  performQuitAndInstall: () => void | Promise<void>
  sendStatus: (status: UpdateStatus) => void
  shouldDeferMacQuitForInstall: () => boolean
}

// Why: the quit guard never touches the window and must survive a window close while a
// download is staged, so it is registered once per process rather than once per window.
let beforeQuitGuardRegistered = false

/**
 * Tracks Squirrel.Mac readiness: electron-updater fires 'update-downloaded' before the
 * native installer is staged. Returns the disposer that unhooks the native listener.
 */
export function listenForMacInstallerReady(ctx: MacLifecycleListenerContext): () => void {
  if (process.platform !== 'darwin') {
    return () => {}
  }
  const onNativeUpdateDownloaded = (): void => {
    handleMacInstallerReady(
      ctx.hasInstallableDownloadedVersion(),
      ctx.performQuitAndInstall,
      () => {
        // Send the held status only while its staged build is still installable.
        ctx.sendStatus({
          state: 'downloaded',
          version: ctx.getPendingInstallVersion(),
          releaseUrl: ctx.getKnownReleaseUrl()
        })
      }
    )
    ctx.commitMacInstallIfReady()
  }
  nativeUpdater.on('update-downloaded', onNativeUpdateDownloaded)
  return () => nativeUpdater.off('update-downloaded', onNativeUpdateDownloaded)
}

/** Holds app quit until Squirrel.Mac has finished staging a downloaded update. */
export function registerMacBeforeQuitGuardOnce(ctx: MacLifecycleListenerContext): void {
  if (beforeQuitGuardRegistered) {
    return
  }
  beforeQuitGuardRegistered = true
  app.on('before-quit', (event) => {
    if (!ctx.shouldDeferMacQuitForInstall()) {
      return
    }
    if (consumeMacInstallGuardBypass()) {
      recordUpdaterLifecycle('macos_before_quit_guard_bypassed')
      return
    }
    if (isMacQuitAndInstallInFlight()) {
      return
    }
    // Why: quitting before Squirrel.Mac finishes staging leaves nothing to install; hold the quit until it's ready.
    if (
      deferMacQuitUntilInstallerReady(
        ctx.getCurrentStatus(),
        ctx.hasInstallableDownloadedVersion(),
        ctx.getPendingInstallVersion,
        ctx.sendStatus
      )
    ) {
      recordUpdaterLifecycle('macos_before_quit_deferred', {
        version: ctx.getPendingInstallVersion()
      })
      event.preventDefault()
    }
  })
}
