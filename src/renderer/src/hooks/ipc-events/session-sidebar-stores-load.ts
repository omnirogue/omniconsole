import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { useWaitLater } from '@/store/wait-later-store'

/** The sidebar's organization stores, loaded before a relayed change reads or applies them. */
export function ensureSessionSidebarStoresLoaded(): void {
  if (!useSessionFolders.getState().loaded) {
    useSessionFolders.getState().load()
  }
  if (!useSessionSidebarView.getState().loaded) {
    useSessionSidebarView.getState().load()
  }
  if (!useSessionTags.getState().loaded) {
    useSessionTags.getState().load()
  }
  if (!useWaitLater.getState().loaded) {
    useWaitLater.getState().load()
  }
}
