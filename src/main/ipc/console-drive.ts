import { ipcMain } from 'electron'
import { consoleDriveClient } from '../backoffice/console-drive-client'

export function registerConsoleDriveHandlers(): void {
  for (const name of ['get', 'intakes', 'declare', 'requestFiles'] as const) {
    ipcMain.handle(`consoleDrive:${name}`, (_event, args) => {
      const operation = consoleDriveClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
