import { ipcMain } from 'electron'
import { consoleAccessClient } from '../backoffice/console-access-client'

/** One handler per Tool Shelf read or change; the client owns validation and the credential. */
export function registerConsoleAccessHandlers(): void {
  for (const name of ['mine', 'people', 'person', 'change', 'sections', 'bulk'] as const) {
    ipcMain.handle(`consoleAccess:${name}`, (_event, args) => {
      const operation = consoleAccessClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
