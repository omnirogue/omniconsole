import type { StoreApi } from 'zustand'
import {
  currentArchiveExecutor,
  type ConversationArchiveEvent
} from '@/lib/session-archive-events'
import type { SessionSidebarViewState } from './session-sidebar-view-state'

/**
 * Makes a sidebar view store announce every archive and unarchive it applies, whichever path asked
 * (a person, the CLI, a pane's agent, account sync, a handoff transfer, the steward, automatic
 * filing), named by the executor scope the change path set. Loading the list and migrating a key
 * are not archives and announce nothing. Only the window's store is wrapped, so test and fixture
 * stores never reach the window's listeners.
 */
export function announceArchiveChanges(
  store: Pick<StoreApi<SessionSidebarViewState>, 'getState' | 'setState'>,
  notify: (event: ConversationArchiveEvent) => void
): void {
  const { setArchived, archiveTransfer, archiveVerified } = store.getState()
  store.setState({
    setArchived: (keys, archived, origin) => {
      setArchived(keys, archived, origin)
      if (keys.length > 0) {
        const via =
          origin === 'account-sync'
            ? 'sync'
            : origin === 'resume'
              ? 'resume'
              : (currentArchiveExecutor() ?? 'unknown')
        notify({ keys, archived, via })
      }
    },
    // Why after: a transfer that could not commit throws, and nothing was archived.
    archiveTransfer: (keys, operationId, commit) => {
      archiveTransfer(keys, operationId, commit)
      notify({ keys, archived: true, via: 'transfer' })
    },
    archiveVerified: (key, proof) => {
      const filed = archiveVerified(key, proof)
      if (filed) {
        const scoped = currentArchiveExecutor()
        notify({ keys: [key], archived: true, via: scoped === 'steward' ? scoped : 'auto-archive' })
      }
      return filed
    }
  })
}
