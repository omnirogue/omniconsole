import { ipcMain } from 'electron'
import { DISCOVER_CREDIT_QUOTE_CHANNEL } from '../../shared/discover-credit-quote-ipc'
import { quoteDiscoverCredits } from '../runtime/workflow-script/discover-credit-quote'

export function registerWorkflowScriptHandlers(): void {
  ipcMain.removeHandler(DISCOVER_CREDIT_QUOTE_CHANNEL)
  ipcMain.handle(DISCOVER_CREDIT_QUOTE_CHANNEL, (_event, request: unknown) =>
    quoteDiscoverCredits(request)
  )
}
