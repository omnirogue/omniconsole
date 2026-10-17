import { create } from 'zustand'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import {
  defaultSessionTags,
  migrateSessionTags,
  parseSessionTags,
  type SessionTagData
} from '@/lib/session-tags'
import { translate } from '@/i18n/i18n'

const KEY = 'omni.session-tags.v1'
type TagState = {
  data: SessionTagData
  scope: string | null
  loaded: boolean
  error: string | null
  load: () => void
  save: (data: SessionTagData) => boolean
  /** Which tags the sidebar shows; a view, not a change to any session's tags. */
  setFilter: (filter: string[]) => boolean
  migrateSessionKey: (from: string, to: string) => boolean
}
export function createSessionTagsStore(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
) {
  return create<TagState>((set, get) => ({
    data: defaultSessionTags(),
    scope: null,
    loaded: false,
    error: null,
    load: () => {
      const scope = personalViewStorageKey(KEY)
      try {
        const raw = getStorage().getItem(scope)
        set({
          data: raw === null ? defaultSessionTags() : parseSessionTags(JSON.parse(raw)),
          scope,
          loaded: true,
          error: null
        })
      } catch {
        set({
          data: defaultSessionTags(),
          scope,
          loaded: false,
          error: translate(
            'sessionTags.readFailed',
            'Could not read your tags. Retry before making changes.'
          )
        })
      }
    },
    save: (data) => {
      if (!get().loaded || get().scope !== personalViewStorageKey(KEY)) {
        get().load()
        return false
      }
      try {
        const parsed = parseSessionTags(data)
        getStorage().setItem(get().scope!, JSON.stringify(parsed))
        set({ data: parsed, error: null })
        return true
      } catch {
        set({
          error: translate(
            'sessionTags.saveFailed',
            'Could not save your tags. Names must be unique and between 1 and 40 characters.'
          )
        })
        return false
      }
    },
    setFilter: (filter) => get().save({ ...get().data, filter }),
    migrateSessionKey: (from, to) => {
      const data = get().data
      const migrated = migrateSessionTags(data, from, to)
      return migrated === data ? false : get().save(migrated)
    }
  }))
}
export const useSessionTags = createSessionTagsStore()
