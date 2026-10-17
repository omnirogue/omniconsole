import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'

export type SessionLedgerStorage = {
  load(key: 'muted-repos' | 'seen-peers'): string[]
  save(key: 'muted-repos' | 'seen-peers', values: string[]): void
}

export function createLocalSessionLedgerStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
): SessionLedgerStorage {
  return {
    load(key) {
      try {
        const value: unknown = JSON.parse(
          readPersonalView(getStorage(), `session-ledger-${key}`) ?? '[]'
        )
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : []
      } catch {
        return []
      }
    },
    save(key, values) {
      try {
        getStorage().setItem(
          personalViewStorageKey(`session-ledger-${key}`),
          JSON.stringify(values)
        )
      } catch {
        /* Presentation preferences remain usable when storage is full. */
      }
    }
  }
}
