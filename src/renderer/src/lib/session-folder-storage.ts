import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'
import {
  emptySessionFolderMetadata,
  parseSessionFolderMetadata,
  type SessionFolderMetadata
} from './session-folders'

export type SessionFolderStorage = {
  load(): SessionFolderMetadata
  save(metadata: SessionFolderMetadata): void
}

export const SESSION_FOLDERS_STORAGE_KEY = 'omni.session-folders.v1'

// Per-device presentation metadata, like linear-issue-view-storage; never sent to a host.
export function createLocalSessionFolderStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage,
  storageKey: string = SESSION_FOLDERS_STORAGE_KEY
): SessionFolderStorage {
  return {
    load() {
      const raw = readPersonalView(getStorage(), storageKey)
      return raw === null
        ? emptySessionFolderMetadata()
        : parseSessionFolderMetadata(JSON.parse(raw))
    },
    save(metadata) {
      getStorage().setItem(personalViewStorageKey(storageKey), JSON.stringify(metadata))
    }
  }
}
