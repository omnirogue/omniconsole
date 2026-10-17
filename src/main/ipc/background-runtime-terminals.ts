import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  END_BACKGROUND_TERMINAL_CHANNEL,
  LIST_BACKGROUND_TERMINALS_CHANNEL,
  type BackgroundRuntimeTerminal,
  type EndBackgroundTerminalReply
} from '../../shared/background-runtime-terminal'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import {
  backgroundEndSummary,
  endBackgroundRuntimeTerminal
} from '../session-manage/session-manage-background-end'

function assertCurrentMainFrame(event: Electron.IpcMainInvokeEvent): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Background terminal requests must originate from the current main frame')
  }
}

/**
 * The owner's Conversations sidebar reads the runtime-owned terminals no window tab shows, so a
 * process an earlier click started is visible where it runs, and a person can end one. Own window
 * only, never a peer; ending re-checks and is audited like `session tidy --delete`.
 */
export function registerBackgroundRuntimeTerminalsHandler(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(LIST_BACKGROUND_TERMINALS_CHANNEL)
  ipcMain.handle(LIST_BACKGROUND_TERMINALS_CHANNEL, (event): BackgroundRuntimeTerminal[] | null => {
    assertCurrentMainFrame(event)
    return runtime.listBackgroundRuntimeOwnedTerminals()
  })
  ipcMain.removeHandler(END_BACKGROUND_TERMINAL_CHANNEL)
  ipcMain.handle(
    END_BACKGROUND_TERMINAL_CHANNEL,
    async (event, request: unknown): Promise<EndBackgroundTerminalReply> => {
      assertCurrentMainFrame(event)
      const ptyId =
        request && typeof request === 'object' && 'ptyId' in request ? request.ptyId : null
      if (typeof ptyId !== 'string' || ptyId.length === 0) {
        throw new Error('Ending a background terminal needs its ptyId.')
      }
      const { terminal, closed } = await endBackgroundRuntimeTerminal(
        { runtime, clientKind: 'runtime' },
        ptyId
      )
      const title = terminal.title?.trim() || 'Terminal'
      const auditError = await sessionActionsLogFor(getProfileUserDataPath()).append({
        actor: 'person',
        action: 'session.delete',
        target: { paneKey: terminal.paneKey, tabId: terminal.tabId, title },
        summary: backgroundEndSummary(title),
        reason: 'Ended from the Conversations sidebar.',
        after: { ptyId: terminal.ptyId, ptyKilled: closed.ptyKilled, background: true }
      })
      return { ended: true, ptyKilled: closed.ptyKilled, ...(auditError ? { auditError } : {}) }
    }
  )
}
