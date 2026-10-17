import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL } from '../../shared/session-conversation-ledger'

/**
 * The window publishes its own conversation ledger to its own main process (session parity,
 * step 2); main carries it to paired clients beside each workspace snapshot.
 */
export function registerSessionConversationLedgerHandler(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL)
  ipcMain.handle(SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL, (event, publication: unknown): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      throw new Error('Conversation ledgers must originate from a BrowserWindow')
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Conversation ledgers must originate from the current main frame')
    }
    runtime.syncSessionConversationLedger(window.id, publication)
  })
}
