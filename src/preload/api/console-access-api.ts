import type { IpcRenderer } from 'electron'
import type { ConsoleAccessApi } from '../../shared/console-access-contract'

export function createConsoleAccessApi(ipc: Pick<IpcRenderer, 'invoke'>): ConsoleAccessApi {
  return {
    mine: (args) => ipc.invoke('consoleAccess:mine', args ?? {}),
    people: () => ipc.invoke('consoleAccess:people'),
    person: (args) => ipc.invoke('consoleAccess:person', args),
    change: (args) => ipc.invoke('consoleAccess:change', args),
    sections: () => ipc.invoke('consoleAccess:sections'),
    bulk: (args) => ipc.invoke('consoleAccess:bulk', args)
  }
}
