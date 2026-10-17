import type { IpcRenderer } from 'electron'
import type { ConsoleTeamRoutinesApi } from '../../shared/console-team-routines-contract'

export function createConsoleTeamRoutinesApi(
  ipc: Pick<IpcRenderer, 'invoke'>
): ConsoleTeamRoutinesApi {
  return {
    list: () => ipc.invoke('consoleTeamRoutines:list'),
    get: (args) => ipc.invoke('consoleTeamRoutines:get', args),
    runs: (args) => ipc.invoke('consoleTeamRoutines:runs', args),
    share: (args) => ipc.invoke('consoleTeamRoutines:share', args),
    enable: (args) => ipc.invoke('consoleTeamRoutines:enable', args),
    disable: (args) => ipc.invoke('consoleTeamRoutines:disable', args),
    create: (args) => ipc.invoke('consoleTeamRoutines:create', args)
  }
}
