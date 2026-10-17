import { ipcMain } from 'electron'
import { consoleAdvertisingClient } from '../backoffice/console-advertising-client'

/** One handler per advertising read. Reads only: this surface has no write. */
export function registerConsoleAdvertisingHandlers(): void {
  for (const name of ['salesAds', 'dailySales', 'webinar', 'adOps', 'decision'] as const) {
    ipcMain.handle(`consoleAdvertising:${name}`, (_event, args) => {
      const operation = consoleAdvertisingClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
