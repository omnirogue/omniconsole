import type { IpcRenderer } from 'electron'
import type { ConsoleDriveApi } from '../../shared/console-drive-contract'

export function createConsoleDriveApi(ipc: Pick<IpcRenderer, 'invoke'>): ConsoleDriveApi {
  return {
    get: (args) => ipc.invoke('consoleDrive:get', args),
    intakes: (args) => ipc.invoke('consoleDrive:intakes', args),
    declare: (args) => ipc.invoke('consoleDrive:declare', args),
    requestFiles: (args) => ipc.invoke('consoleDrive:requestFiles', args)
  }
}
