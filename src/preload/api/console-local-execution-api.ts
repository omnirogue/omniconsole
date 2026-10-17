import type { IpcRenderer } from 'electron'
import type { ConsoleLocalExecutionClientApi } from '../../shared/console-local-execution'

export function createConsoleLocalExecutionApi(
  ipc: Pick<IpcRenderer, 'invoke'>
): ConsoleLocalExecutionClientApi {
  return {
    taskContinuationCapabilities: (args) =>
      ipc.invoke('consoleLocalExecution:taskContinuationCapabilities', args),
    continueTask: (args) => ipc.invoke('consoleLocalExecution:continueTask', args),
    start: (args) => ipc.invoke('consoleLocalExecution:start', args),
    list: () => ipc.invoke('consoleLocalExecution:list'),
    cancel: (args) => ipc.invoke('consoleLocalExecution:cancel', args),
    readWorker: (args) => ipc.invoke('consoleLocalExecution:readWorker', args),
    focus: (args) => ipc.invoke('consoleLocalExecution:focus', args),
    autoAdvanceGet: (args) => ipc.invoke('consoleLocalExecution:autoAdvanceGet', args),
    autoAdvanceSet: (args) => ipc.invoke('consoleLocalExecution:autoAdvanceSet', args)
  }
}
