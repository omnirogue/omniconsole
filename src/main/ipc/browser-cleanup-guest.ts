import { ipcMain, type WebContents } from 'electron'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { browserManager } from '../browser/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import type {
  BrowserCleanupGuestRequest,
  BrowserCleanupGuestResult
} from '../../shared/browser-cleanup'

async function hasNoUnloadHandlers(guest: WebContents): Promise<boolean> {
  try {
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach('1.3')
    }
    const object = await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window',
      objectGroup: 'browser-cleanup'
    })
    const objectId = object?.result?.objectId
    if (typeof objectId !== 'string') {
      return false
    }
    try {
      const result = await guest.debugger.sendCommand('DOMDebugger.getEventListeners', { objectId })
      return (
        Array.isArray(result?.listeners) &&
        result.listeners.every(
          (listener: { type?: unknown }) =>
            typeof listener.type === 'string' &&
            listener.type !== 'beforeunload' &&
            listener.type !== 'unload'
        )
      )
    } finally {
      await guest.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {})
    }
  } catch {
    return false
  }
}

export function registerBrowserCleanupGuestHandler(): void {
  ipcMain.removeHandler('browser:cleanupCloseGuest')
  ipcMain.handle(
    'browser:cleanupCloseGuest',
    async (event, args: BrowserCleanupGuestRequest): Promise<BrowserCleanupGuestResult> => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !args ||
        typeof args.pageId !== 'string' ||
        typeof args.url !== 'string' ||
        !Number.isInteger(args.guestId)
      ) {
        return 'kept'
      }
      const guest = browserManager.getAuthorizedGuest(args.pageId, event.sender.id)
      if (
        !guest ||
        guest.isDestroyed() ||
        guest.id !== args.guestId ||
        guest.getURL() !== args.url ||
        guest.isLoading() ||
        guest.isCurrentlyAudible() ||
        guest.isBeingCaptured() ||
        browserManager.hasActiveDownloadForPage(args.pageId)
      ) {
        return 'kept'
      }
      let navigated = false
      const changed = (): void => {
        navigated = true
      }
      guest.on('did-start-navigation', changed)
      try {
        // Embedded guests can ignore a native unload veto, so do not attempt to close one with handlers.
        const clear = await withTimeout(hasNoUnloadHandlers(guest), 1_500, false)
        if (
          !clear ||
          navigated ||
          guest.isDestroyed() ||
          browserManager.getAuthorizedGuest(args.pageId, event.sender.id) !== guest ||
          guest.getURL() !== args.url ||
          guest.isLoading() ||
          guest.isCurrentlyAudible() ||
          guest.isBeingCaptured() ||
          browserManager.hasActiveDownloadForPage(args.pageId)
        ) {
          return 'kept'
        }
        return await new Promise<BrowserCleanupGuestResult>((resolve) => {
          const finish = (result: BrowserCleanupGuestResult): void => {
            clearTimeout(timer)
            guest.removeListener('destroyed', closed)
            resolve(result)
          }
          const closed = (): void => finish('closed')
          const timer = setTimeout(() => finish('unconfirmed'), 3_000)
          guest.once('destroyed', closed)
          // Still request beforeunload for a handler added after inspection; only destruction confirms closure.
          try {
            guest.close({ waitForBeforeUnload: true })
          } catch {
            finish('unconfirmed')
          }
        })
      } finally {
        guest.removeListener('did-start-navigation', changed)
      }
    }
  )
}
