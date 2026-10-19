import { BrowserWindow, ipcMain } from 'electron'
import {
  getSharedOmniRogueSessionSpendLedger,
  type OmniRogueSessionSpendLedger,
  type OmniRogueSessionSpendSnapshot
} from '../omnirogue-account/omnirogue-session-spend-ledger'

export type OmniRogueSessionSpendView = Pick<
  OmniRogueSessionSpendSnapshot,
  'sessionId' | 'spentCredits' | 'reservedCredits' | 'budgetCredits' | 'requestCount' | 'updatedAt'
>

export function toSessionSpendView(
  snapshot: OmniRogueSessionSpendSnapshot
): OmniRogueSessionSpendView {
  const { sessionId, spentCredits, reservedCredits, budgetCredits, requestCount, updatedAt } =
    snapshot
  return { sessionId, spentCredits, reservedCredits, budgetCredits, requestCount, updatedAt }
}

let unsubscribeBroadcast: (() => void) | null = null

/** Read-only view of the W5-38 ledger; re-registering replaces the earlier broadcast. */
export function registerOmniRogueSpendLedgerIpc(
  ledger: OmniRogueSessionSpendLedger = getSharedOmniRogueSessionSpendLedger()
): () => void {
  unsubscribeBroadcast?.()
  ipcMain.removeHandler('omnirogue:spend:list-sessions')
  ipcMain.handle('omnirogue:spend:list-sessions', (): OmniRogueSessionSpendView[] =>
    ledger.list().map(toSessionSpendView)
  )
  const unsubscribe = ledger.onChange((snapshot) => {
    const view = toSessionSpendView(snapshot)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('omnirogue:spend:session-changed', view)
      }
    }
  })
  unsubscribeBroadcast = () => {
    unsubscribe()
    unsubscribeBroadcast = null
  }
  return unsubscribeBroadcast
}
