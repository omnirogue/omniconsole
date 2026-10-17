import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateSidebarSession } from './activate-sidebar-session'
import { openSessionLedgerConsole } from './session-ledger-console'
import { buildSidebarSessions } from './sidebar-sessions'

/**
 * omni://backoffice/session/<als_…> (the web Decisions list's "Open in OmniConsole"): open that
 * conversation as a click on its sidebar row would — a live one gets focus, an ended one is
 * resumed. A session this desktop does not hold opens its page on the web instead.
 */
export function openLinkedSession(target: {
  sessionLedgerId: string
  executionHostId?: string
  sessionKey?: string
  paneKey?: string
  nativeSessionId?: string
}): void {
  const sessions = buildSidebarSessions(useAppStore.getState())
  const row = target.sessionKey
    ? sessions.find((session) => session.sessionKey === target.sessionKey)
    : target.executionHostId
      ? sessions.find(
          (session) =>
            session.hostId === target.executionHostId &&
            ((target.paneKey && session.paneKey === target.paneKey) ||
              (target.nativeSessionId && session.providerSession?.id === target.nativeSessionId))
        )
      : undefined
  if (!row) {
    toast.message(
      translate(
        'decisions.linkedSessionMissing',
        'That session is not on this computer, so its page opens on the web.'
      )
    )
    openSessionLedgerConsole(target.sessionLedgerId)
    return
  }
  void activateSidebarSession(row).then((opened) => {
    if (!opened) {
      toast.error(
        translate(
          'work.openSessionFailed',
          'This session could not be opened; check its workspace.'
        )
      )
    }
  })
}
