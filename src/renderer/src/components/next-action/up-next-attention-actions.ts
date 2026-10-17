import { toast } from 'sonner'
import { translate as t } from '@/i18n/i18n'
import { openSidebarSession } from '@/components/sidebar/session-folders/open-sidebar-session'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { UpNextAttention } from '../../../../shared/up-next-types'
import { openDoneWhenList } from './use-done-when-list'

/**
 * The doors a request's action opens. Every one is an EXISTING surface — the sidebar's own way
 * of opening a conversation, the Outcome head's checklist, the composer's add bar, the account
 * settings — so meeting a request never needs a second route to the same place.
 */
export type UpNextAttentionDoors = {
  /** Focus the conversation with this pane key; false when no open session has it. */
  openConversation: (paneKey: string) => boolean
  /** Open the Done When checklist of this pursuit, where a review condition is answered. */
  reviewOutcome: (chainId: string) => void
  /** Put the person on the composer's add bar. */
  focusComposer: () => void
  openAccount: () => void
}

function openConversation(paneKey: string): boolean {
  const session = buildSidebarSessions(useAppStore.getState()).find(
    (candidate) => candidate.paneKey === paneKey
  )
  if (session) {
    openSidebarSession(session)
  }
  return Boolean(session)
}

function openAccount(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({ pane: 'omni-account', repoId: null })
  openSettingsPage()
}

export function upNextAttentionDoors(focusComposer: () => void): UpNextAttentionDoors {
  return { openConversation, reviewOutcome: openDoneWhenList, focusComposer, openAccount }
}

/** Where the surface showing a request stands: the run it reads, and the conversation it is in. */
export type UpNextAttentionContext = {
  /** The pane of the conversation this surface belongs to; null for a card or a thread. */
  ownPaneKey: string | null
  chainId: string | null
}

/**
 * Take the person to where this request is met. A request whose worker has no pane of its own is
 * answered in the conversation the surface belongs to; one that cannot be opened says so.
 */
export function runUpNextAttentionAction(
  request: Pick<UpNextAttention, 'action'>,
  context: UpNextAttentionContext,
  doors: UpNextAttentionDoors
): void {
  const action = request.action
  if (!action) {
    return
  }
  switch (action.kind) {
    case 'open-conversation': {
      const paneKey = action.paneKey ?? context.ownPaneKey
      if (!paneKey || !doors.openConversation(paneKey)) {
        toast.error(
          t('upNext.attention.conversationGone', 'That conversation is not open on this device.')
        )
      }
      return
    }
    case 'review-outcome':
      if (context.chainId) {
        doors.reviewOutcome(context.chainId)
      }
      return
    case 'open-up-next':
      doors.focusComposer()
      return
    case 'sign-in':
      doors.openAccount()
  }
}
