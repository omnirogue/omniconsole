import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { sessionRowHostName } from './session-row-host'
import type { SidebarSession } from './sidebar-sessions'

/** The computer that runs a ledger row's conversation, by the name this computer shows for it. */
export function mirroredConversationComputerName(row: Pick<SidebarSession, 'hostId'>): string {
  return sessionRowHostName(row.hostId, undefined, useAppStore.getState().runtimeEnvironments)
}

/**
 * A click on a conversation a paired owner's ledger lists, with no mirror tab of it here (session
 * parity, step 7): it runs on its owner, so nothing here may open it — no workspace activation, no
 * resume sweep, no new tab. Phase 1b only says where: a paused one is resumed on its owner (step 10,
 * `sessionHosts.resume`), anything else is opened there. Why true: the click is answered; a generic
 * "could not be opened" would blame this computer's workspace.
 */
export function explainMirroredConversationRow(row: SidebarSession): boolean {
  const mirrored = row.mirroredConversation
  if (!mirrored) {
    return false
  }
  const computer = mirroredConversationComputerName(row)
  // Why the digest: the owner sends one only once its agent reported a session (F21 `c:`).
  const hasProviderSession = Boolean(row.providerSession?.id) || mirrored.conversation !== null
  toast(
    mirrored.rest === 'asleep' && hasProviderSession
      ? translate('conversations.mirroredConversationResumeOn', 'Resume it on {{computer}}.', {
          computer
        })
      : translate('conversations.mirroredConversationOpenOn', 'Open it on {{computer}}.', {
          computer
        })
  )
  return true
}
