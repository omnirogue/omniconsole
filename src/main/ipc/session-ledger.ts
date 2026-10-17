import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  SESSION_LEDGER_IPC_PREFIX,
  type LedgerLocalSession
} from '../../shared/session-ledger-contract'
import {
  ledgerIdSchema,
  ledgerRepoSchema,
  ledgerScopeSchema
} from '../session-ledger/ledger-client'
import { sessionLedgerService } from '../session-ledger/ledger-service'

const channel = (name: string): string => `${SESSION_LEDGER_IPC_PREFIX}${name}`

export const SESSION_LEDGER_LOCAL_SESSIONS_CHANNEL = channel('local-sessions-changed')

const paneIdSchema = z.string().min(1)
/** A board card, or null to take the conversation back out of its task. */
const linkCardSchema = z.object({
  cardId: z
    .string()
    .regex(/^btk_[A-Za-z0-9]{4,64}$/)
    .nullable(),
  cardTitle: z.string().nullable()
})

let unsubscribeLocalSessions: (() => void) | null = null

/** `window.api.sessionLedger` (contract §10). Every handler answers; none throws to the renderer. */
export function registerSessionLedgerHandlers(): void {
  ipcMain.handle(channel('task-link'), (_event, paneKey: unknown) => {
    const parsed = paneIdSchema.safeParse(paneKey)
    return parsed.success ? sessionLedgerService.resumeLinks.read(parsed.data) : null
  })
  ipcMain.handle(channel('now'), (_event, scope: unknown) => {
    const parsed = ledgerScopeSchema.safeParse(scope)
    return sessionLedgerService.now(parsed.success ? parsed.data : 'live')
  })
  ipcMain.handle(channel('peers'), (_event, ledgerId: unknown) => {
    const parsed = ledgerIdSchema.safeParse(ledgerId)
    return parsed.success
      ? sessionLedgerService.peers(parsed.data)
      : Promise.resolve({ ok: false as const, reason: 'unavailable' })
  })
  ipcMain.handle(channel('local-sessions'), () => sessionLedgerService.localSessions())
  ipcMain.handle(channel('set-waiting'), async (_event, ledgerId: unknown, waiting: unknown) => {
    const parsed = ledgerIdSchema.safeParse(ledgerId)
    if (parsed.success) {
      await sessionLedgerService.setWaiting(parsed.data, waiting === true)
    }
  })
  ipcMain.handle(channel('link-card'), async (_event, paneId: unknown, card: unknown) => {
    const pane = paneIdSchema.safeParse(paneId)
    const parsed = linkCardSchema.safeParse(card)
    if (!pane.success || !parsed.success) {
      return false
    }
    try {
      return await sessionLedgerService.linkCard(pane.data, parsed.data)
    } catch (error) {
      console.warn('[session-ledger] card link failed', error)
      return false
    }
  })
  ipcMain.handle(channel('mute-repo'), (_event, repo: unknown, muted: unknown) => {
    const parsed = ledgerRepoSchema.safeParse(repo)
    if (parsed.success) {
      try {
        sessionLedgerService.muteRepo(parsed.data, muted === true)
      } catch (error) {
        console.warn('[session-ledger] mute persist failed', error)
      }
    }
  })
  ipcMain.handle(channel('muted-repos'), () => {
    try {
      return sessionLedgerService.mutedRepos()
    } catch {
      return []
    }
  })
  unsubscribeLocalSessions?.()
  unsubscribeLocalSessions = sessionLedgerService.subscribeLocalSessions(
    (rows: LedgerLocalSession[]) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(SESSION_LEDGER_LOCAL_SESSIONS_CHANNEL, rows)
        }
      }
    }
  )
}
