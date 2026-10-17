import { ipcMain } from 'electron'
import { consoleRoutineConversationClient as client } from '../backoffice/console-routine-conversation-client'

export function registerConsoleRoutineConversationHandlers(): void {
  ipcMain.handle('consoleRoutineConversation:get', (_event, args) => client.getConversation(args))
  ipcMain.handle('consoleRoutineConversation:post', (_event, args) => client.postMessage(args))
}
