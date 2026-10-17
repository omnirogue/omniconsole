import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  pendingSessionOrganizationIntent,
  sessionOrganizationScope,
  settleSessionOrganizationIntent
} from '@/lib/account-sync/session-organization-intent'
import {
  createSessionAccountSync,
  type SessionSyncProblem
} from '@/lib/account-sync/session-sync-engine'
import { createSessionSyncOwnership } from '@/lib/account-sync/session-sync-ownership'
import { organizationOwnershipOutbox } from '@/lib/session-organization-ownership'
import {
  isHostOrganizationSettled,
  onHostOrganizationSettled
} from '@/lib/session-organization-host-settle'
import { conversationViewKey } from '@/lib/conversation-view'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionOrganizationOwnership } from '@/store/session-organization-ownership'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionOrganizationOwnershipMirror } from './use-session-organization-ownership'

const PASS_EVERY_MS = 60_000
const AFTER_EDIT_MS = 2_000

/** The keys this computer shows its sessions under now, so a synced change can find them. */
function presentSessionKeys(): string[] {
  return buildSidebarSessions(useAppStore.getState()).flatMap((session) => {
    const key = conversationViewKey(session)
    return session.sessionKey && session.sessionKey !== key ? [key, session.sessionKey] : [key]
  })
}

function reportProblem(problem: SessionSyncProblem): void {
  toast.error(
    problem.kind === 'too-large'
      ? translate(
          'sessionSync.tooLarge',
          'Some session folders are too large to sync to your account. They stay on this computer.'
        )
      : translate(
          'sessionSync.refused',
          'Session folders could not sync to your account: {{message}}',
          { message: problem.message }
        )
  )
}

/**
 * Keeps session folders, folder moves and archiving the same on every computer signed in to this
 * OmniConsole account: a pass a minute, on focus, and shortly after a local change.
 */
export function useSessionAccountSync(): void {
  // Why here: ownership is kept whether or not this computer syncs, and sync is its main reader.
  useSessionOrganizationOwnershipMirror()
  useEffect(() => {
    const api = window.api?.backoffice
    if (typeof api?.accountSyncRead !== 'function' || typeof api.accountSyncWrite !== 'function') {
      return
    }
    const sync = createSessionAccountSync({
      read: () => api.accountSyncRead(),
      write: (args) => api.accountSyncWrite(args),
      local: {
        // Why the host too: changes it committed with no window are adopted before a pass reads them.
        ready: () =>
          useSessionFolders.getState().loaded &&
          useSessionSidebarView.getState().loaded &&
          isHostOrganizationSettled(),
        scope: sessionOrganizationScope,
        input: () => {
          const view = useSessionSidebarView.getState()
          return {
            metadata: useSessionFolders.getState().metadata,
            archived: view.archived,
            archivedAt: view.view.archivedAt ?? {},
            present: presentSessionKeys(),
            folderPaths: Object.fromEntries(
              useAppStore
                .getState()
                .folderWorkspaces.map((workspace) => [workspace.id, workspace.folderPath])
            )
          }
        },
        replaceMetadata: (metadata) => {
          useSessionFolders.getState().replaceMetadata(metadata)
        },
        setArchived: (keys, archived) =>
          useSessionSidebarView.getState().setArchived(keys, archived, 'account-sync')
      },
      intent: {
        pending: pendingSessionOrganizationIntent,
        settle: settleSessionOrganizationIntent
      },
      newDevice: () => crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      storage: localStorage,
      now: () => Date.now(),
      report: reportProblem,
      organization: createSessionSyncOwnership({
        mirror: useSessionOrganizationOwnership.getState(),
        outbox: organizationOwnershipOutbox
      })
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = (): void => {
      if (sync.isApplying()) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => void sync.run(), AFTER_EDIT_MS)
    }
    const stopFolders = useSessionFolders.subscribe((state, previous) => {
      if (state.metadata !== previous.metadata) {
        soon()
      }
    })
    const stopView = useSessionSidebarView.subscribe((state, previous) => {
      if (state.archived !== previous.archived) {
        soon()
      }
    })
    const interval = setInterval(() => void sync.run(), PASS_EVERY_MS)
    const onFocus = (): void => void sync.run()
    window.addEventListener('focus', onFocus)
    const stopSettled = onHostOrganizationSettled(() => void sync.run())
    void sync.run()
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      stopSettled()
      stopFolders()
      stopView()
    }
  }, [])
}
