import { BrowserWindow, ipcMain } from 'electron'
import {
  REMEMBER_CONVERSATION_LEDGER_CHANNEL,
  readRememberConversationLedgerRequest
} from '../../shared/remote-conversation-ledger-snapshot'
import { getRemoteConversationLedgerStore } from '../session-host-remote/remote-conversation-ledger-runtime'

/**
 * The window remembers what it reconciled of a paired owner's conversation ledger (session parity,
 * step 5); its own main keeps it durably, so a restart while that owner is offline still lists the
 * owner's conversations "as of <time>". Beside the window's own ledger publication
 * (session-conversation-ledger.ts); nothing here reaches another computer.
 */
export function registerRemoteConversationLedgerHandler(): void {
  ipcMain.removeHandler(REMEMBER_CONVERSATION_LEDGER_CHANNEL)
  ipcMain.handle(
    REMEMBER_CONVERSATION_LEDGER_CHANNEL,
    async (event, request: unknown): Promise<void> => {
      if (!BrowserWindow.fromWebContents(event.sender)) {
        throw new Error('Conversation ledger snapshots must originate from a BrowserWindow')
      }
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Conversation ledger snapshots must originate from the current main frame')
      }
      const read = readRememberConversationLedgerRequest(request)
      if (!read) {
        throw new Error('Invalid conversation ledger snapshot')
      }
      await getRemoteConversationLedgerStore().remember(read)
    }
  )
}
