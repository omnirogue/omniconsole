import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { parseCustomerServiceLaunchLink } from '../../shared/customer-service-launch'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { sessionLedgerService } from '../session-ledger/ledger-service'
import { CustomerServiceLaunchService } from '../customer-service/launch-service'
import { CustomerServiceLaunchStore } from '../customer-service/launch-store'

let pending: string | null = null
export function captureCustomerServiceLinks(
  values: readonly string[],
  getWindow: () => BrowserWindow | null
): boolean {
  const id = values.map(parseCustomerServiceLaunchLink).find(Boolean)
  if (!id) {
    return false
  }
  pending = id
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    safelyRevealWindow(window)
    window.webContents.send('customerService:open', id)
  }
  return true
}

export function registerCustomerServiceLinks(
  getWindow: () => BrowserWindow | null,
  activate: () => void
): void {
  const services = new Map<string, CustomerServiceLaunchService>()
  const service = () => {
    const path = getProfileUserDataPath()
    let existing = services.get(path)
    if (!existing) {
      existing = new CustomerServiceLaunchService({
        store: new CustomerServiceLaunchStore(join(path, 'customer-service-launches')),
        localSessions: () => sessionLedgerService.localSessions()
      })
      services.set(path, existing)
    }
    return existing
  }
  const allowed = (senderId: number) => getWindow()?.webContents.id === senderId
  captureCustomerServiceLinks(process.argv, getWindow)
  app.on('open-url', (event, value) => {
    if (captureCustomerServiceLinks([value], getWindow)) {
      event.preventDefault()
      activate()
    }
  })
  ipcMain.handle('customerService:consumePending', (event) => {
    if (!allowed(event.sender.id)) {
      return null
    }
    const id = pending
    pending = null
    return id
  })
  for (const operation of ['preview', 'begin', 'receipt'] as const) {
    ipcMain.handle(`customerService:${operation}`, (event, args) => {
      if (!allowed(event.sender.id)) {
        return {
          ok: false,
          error: { code: 'forbidden', message: 'Only the desktop can confirm this launch.' }
        }
      }
      return service()[operation](args)
    })
  }
}
