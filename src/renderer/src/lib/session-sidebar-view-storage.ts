import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'
import {
  emptySessionSidebarView,
  parseSessionSidebarView,
  type SessionSidebarView
} from './session-sidebar-view'

export type SessionSidebarViewStorage = {
  projectionScope?: () => string
  load(): SessionSidebarView
  save(view: SessionSidebarView): void
}

export const SESSION_SIDEBAR_VIEW_STORAGE_KEY = 'omni.session-sidebar-view.v1'

// Per-device presentation metadata, like session-folder-storage; never sent to a host.
export function createLocalSessionSidebarViewStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage,
  storageKey: string = SESSION_SIDEBAR_VIEW_STORAGE_KEY
): SessionSidebarViewStorage {
  return {
    projectionScope: () => personalViewStorageKey(storageKey),
    load() {
      const raw = readPersonalView(getStorage(), storageKey)
      return raw === null ? emptySessionSidebarView() : parseSessionSidebarView(JSON.parse(raw))
    },
    save(view) {
      getStorage().setItem(personalViewStorageKey(storageKey), JSON.stringify(view))
    }
  }
}
