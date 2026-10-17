import { personalViewStorageKey, readPersonalView } from './personal-view-storage'

export type SessionArchivedStorage = {
  load(): readonly string[]
  save(keys: readonly string[]): void
}

export const SESSION_ARCHIVED_STORAGE_KEY = 'omni.session-sidebar-archived.v1'

// Keep the former storage slot readable for candidates predating view.archived.
export function createLocalSessionArchivedStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
): SessionArchivedStorage {
  return {
    load() {
      const raw = readPersonalView(getStorage(), SESSION_ARCHIVED_STORAGE_KEY)
      const parsed: unknown = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(parsed)
        ? [...new Set(parsed.filter((key): key is string => typeof key === 'string' && !!key))]
        : []
    },
    save(keys) {
      getStorage().setItem(
        personalViewStorageKey(SESSION_ARCHIVED_STORAGE_KEY),
        JSON.stringify(keys)
      )
    }
  }
}
