import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useEffect } from 'react'
import { create } from 'zustand'
import {
  emptySessionTaskLinks,
  parseSessionTaskLinks,
  SESSION_TASK_STORAGE_KEY,
  setSessionTaskLink,
  type SessionTaskLink,
  type SessionTaskLinks
} from '@/lib/session-task-link'

export type SessionTaskStorage = {
  load(): SessionTaskLinks
  save(links: SessionTaskLinks): void
}

/** Per-device, like the other presentation stores; the hub holds the real link. */
export function createLocalSessionTaskStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
): SessionTaskStorage {
  return {
    load() {
      try {
        const raw = getStorage().getItem(SESSION_TASK_STORAGE_KEY)
        return raw === null ? emptySessionTaskLinks() : parseSessionTaskLinks(JSON.parse(raw))
      } catch {
        return emptySessionTaskLinks()
      }
    },
    save(links) {
      try {
        getStorage().setItem(SESSION_TASK_STORAGE_KEY, JSON.stringify(links))
      } catch {
        // Why: a storage failure must not undo the on-screen link; the hub already has it.
      }
    }
  }
}

type SessionTaskState = {
  links: SessionTaskLinks
  loaded: boolean
  load: () => void
  /** Remember (or forget) which task this conversation serves. */
  link: (paneKey: string, next: SessionTaskLink | null) => void
}

export function createSessionTaskStore(storage: SessionTaskStorage) {
  return create<SessionTaskState>((set, get) => ({
    links: emptySessionTaskLinks(),
    loaded: false,
    load: () => {
      if (get().loaded) {
        return
      }
      set({ links: storage.load(), loaded: true })
    },
    link: (paneKey, next) => {
      get().load()
      const previous = get().links
      const links = setSessionTaskLink(previous, paneKey, next)
      if (links === previous) {
        return
      }
      set({ links })
      storage.save(links)
    }
  }))
}

export const useSessionTasks = createSessionTaskStore(createLocalSessionTaskStorage())

/** The task this conversation serves, or null. Loads the map once per app. */
export function useSessionTask(paneKey: string | null): SessionTaskLink | null {
  const account = useAppStore(selectConsoleAccountScope)
  const loaded = useSessionTasks((state) => state.loaded)
  const load = useSessionTasks((state) => state.load)
  const links = useSessionTasks((state) => state.links)
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [load, loaded])
  const link = paneKey ? (links[paneKey] ?? null) : null
  return link?.accountScope && link.accountScope !== account ? null : link
}

export function linkSessionToTask(paneKey: string, next: SessionTaskLink | null): void {
  useSessionTasks.getState().link(paneKey, next)
}
