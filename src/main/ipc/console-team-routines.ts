import { ipcMain } from 'electron'
import { consoleTeamRoutinesClient } from '../backoffice/console-team-routines-client'

export function registerConsoleTeamRoutinesHandlers(): void {
  for (const name of ['list', 'get', 'runs', 'share', 'create', 'enable', 'disable'] as const) {
    ipcMain.handle(`consoleTeamRoutines:${name}`, (_event, args) => {
      const operation = consoleTeamRoutinesClient[name] as (value: unknown) => Promise<unknown>
      return operation(args)
    })
  }
}
