import { translate } from '@/i18n/i18n'
import { sessionRowFolderId } from '@/lib/mirrored-conversation-folders'
import { sessionFolderRevealKeys } from '@/lib/session-folder-cli-list'
import { SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import type { SidebarSession } from '@/lib/sidebar-session-types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { sessionFolderDisplayPath } from '../../../../../shared/session-folder-ref'
import { endSessionFocusDrill } from './use-session-focus-view'

/**
 * Under a Group-by view, where a row is filed, as a chip; clicking it opens the Folders view with
 * that folder (and every folder above it) unfolded. Filed as the tree files it (C3): a paired
 * owner's explicit folder first, named from the owner's catalog when this computer lacks it.
 */
export function SessionRowFolderChip({
  viewKey,
  session
}: {
  viewKey: string
  session: Pick<SidebarSession, 'mirroredConversation'>
}): React.JSX.Element | null {
  const byLens = useSessionSidebarView((state) => state.view.lens !== undefined)
  const folderId = useSessionFolders((state) =>
    byLens ? sessionRowFolderId(state.metadata, session, viewKey) : null
  )
  const saved = folderId === SAVED_SESSIONS_FOLDER_ID
  const path = useSessionFolders((state) => {
    const folder = folderId ? state.metadata.folders.find((entry) => entry.id === folderId) : null
    if (folder) {
      return sessionFolderDisplayPath(state.metadata.folders, folder)
    }
    const owner = session.mirroredConversation?.folderByOwner
    return owner && owner.id === folderId ? owner.name : null
  })
  const shown = saved ? translate('conversations.savedSessions', 'Saved Sessions') : path
  if (!folderId || !shown) {
    return null
  }
  const label = translate('conversations.viewPicker.folderChip', 'Show in Folders: {{folder}}', {
    folder: shown
  })
  const reveal = (event: React.MouseEvent): void => {
    event.stopPropagation()
    const { metadata } = useSessionFolders.getState()
    const keys = sessionFolderRevealKeys(metadata, saved ? null : folderId, saved)
    const store = useSessionSidebarView.getState()
    endSessionFocusDrill()
    store.setViewChoice('folders')
    store.setCollapsed(keys, false)
    if (keys.some((key) => store.view.hidden.includes(key))) {
      store.setShowHidden(true)
    }
  }
  return (
    <button
      type="button"
      data-session-folder-chip={folderId}
      title={label}
      aria-label={label}
      onClick={reveal}
      className="max-w-[40%] shrink truncate rounded-sm border border-worktree-sidebar-border px-1 text-[10px] leading-4 text-muted-foreground outline-none hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring"
    >
      {shown}
    </button>
  )
}
