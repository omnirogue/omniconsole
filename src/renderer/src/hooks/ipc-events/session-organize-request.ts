import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { conversationViewKey } from '@/lib/conversation-view'
import { automaticSessionTag } from '@/lib/session-automatic-tag'
import { undoOrganizationChange } from '@/lib/session-organization-change'
import {
  applyRelayedOrganizationChanges,
  organizedSessionCount
} from '@/lib/session-organization-relayed-changes'
import type { OrganizationStores } from '@/lib/session-organization-values'
import { buildPaneSessions } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { useWaitLater } from '@/store/wait-later-store'
import type { SessionOrganizeRelayReply } from '../../../../shared/session-organize'
import type { OrganizationChange } from '../../../../shared/session-organization-change'
import { useAppStore } from '../../store'

const ORGANIZE_TOAST_DURATION_MS = 20_000

type FindSession = Parameters<typeof applyRelayedOrganizationChanges>[2]

function loadStores(): void {
  for (const store of [useSessionFolders, useSessionSidebarView, useSessionTags, useWaitLater]) {
    if (!store.getState().loaded) {
      store.getState().load()
    }
  }
}

/** The window's stores, with each session's automatic (company) tag so tagging keeps it. */
async function organizeStores(): Promise<OrganizationStores> {
  loadStores()
  const home = await getCompanyFolderHome()
  const state = useAppStore.getState()
  const sessions = new Map(
    buildPaneSessions(state).map((session) => [conversationViewKey(session), session])
  )
  return {
    folders: useSessionFolders,
    view: useSessionSidebarView,
    tags: useSessionTags,
    waitLater: useWaitLater,
    automaticTag: (key) => {
      const session = sessions.get(key)
      return session
        ? automaticSessionTag(session, {
            home,
            workRoot: state.settings?.companyWorkRoot,
            overrides: state.settings?.companyFolders,
            getKnown: state.getKnownWorktreeById
          })
        : null
    }
  }
}

/** Undoes every applied change of one organize, newest first; one notice says how it went. */
async function undoOrganize(opIds: readonly string[]): Promise<void> {
  let undone = 0
  let total = 0
  for (const opId of opIds.toReversed()) {
    const result = await undoOrganizationChange(opId, { via: 'notice' })
    undone += result.undone
    total += result.total
  }
  if (undone === total) {
    toast.success(translate('conversations.organization.undone', 'Undone.'))
    return
  }
  toast.warning(
    translate(
      'conversations.organization.undonePartial',
      'Undid {{undone}} of {{total}}; the rest changed since and were left as they are.',
      { undone, total }
    )
  )
}

function showOrganizeToast(
  changes: readonly OrganizationChange[],
  reply: SessionOrganizeRelayReply
): void {
  const applied = reply.outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.opId)
  if (applied.length === 0) {
    return
  }
  const reason = changes[0]?.reason
  toast(
    translate('conversations.organization.organized', 'Organized {{count}} sessions', {
      count: organizedSessionCount(reply)
    }),
    {
      description: reason
        ? translate(
            'conversations.organization.organizedWhy',
            'By a command run in a terminal session: {{reason}}',
            { reason }
          )
        : translate(
            'conversations.organization.organizedBy',
            'By a command run in a terminal session.'
          ),
      duration: ORGANIZE_TOAST_DURATION_MS,
      action: {
        label: translate('conversations.cliFolders.undo', 'Undo'),
        onClick: () => void undoOrganize(applied)
      }
    }
  )
}

/** `applyOrganizationChanges` from main: one organize plan, one notice with one Undo. */
export async function answerOrganizeChanges(
  changes: readonly OrganizationChange[],
  findSession: FindSession
): Promise<SessionOrganizeRelayReply> {
  const reply = applyRelayedOrganizationChanges(changes, await organizeStores(), findSession)
  showOrganizeToast(changes, reply)
  return reply
}
