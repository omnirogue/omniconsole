import { ipcMain } from 'electron'
import { browserLoginsClient } from '../backoffice/browser-logins-client'

/** One handler per browser-login rail read or write; the client owns validation and the credential. */
export function registerBrowserLoginsHandlers(): void {
  for (const name of ['list', 'status', 'open', 'save', 'verify', 'add', 'verifyAll'] as const) {
    ipcMain.handle(`consoleBrowserLogins:${name}`, (_event, args) => {
      const operation = browserLoginsClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
