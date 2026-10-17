import type { IpcRenderer } from 'electron'
import type { ConsoleRoutineConversationApi } from '../../shared/console-routine-conversation-contract'

export function createConsoleRoutineConversationApi(
  ipc: Pick<IpcRenderer, 'invoke'>
): ConsoleRoutineConversationApi {
  return {
    getConversation: (args) => ipc.invoke('consoleRoutineConversation:get', args),
    postMessage: (args) => ipc.invoke('consoleRoutineConversation:post', args)
  }
}
