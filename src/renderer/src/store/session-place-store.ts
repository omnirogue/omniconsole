import { useEffect } from 'react'
import { create } from 'zustand'
import {
  emptySessionPlaces,
  parseSessionPlaces,
  rememberRecentFolder,
  SESSION_PLACE_STORAGE_KEY,
  setSessionPlace,
  type SessionPlaceChoice,
  type SessionPlaces
} from '@/lib/session-place-choice'

export type SessionPlaceStorage = {
  load(): SessionPlaces
  save(places: SessionPlaces): void
}

/** Per-device, like the task links; the folder tree remains the default filing. */
export function createLocalSessionPlaceStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
): SessionPlaceStorage {
  return {
    load() {
      try {
        const raw = getStorage().getItem(SESSION_PLACE_STORAGE_KEY)
        return raw === null ? emptySessionPlaces() : parseSessionPlaces(JSON.parse(raw))
      } catch {
        return emptySessionPlaces()
      }
    },
    save(places) {
      try {
        getStorage().setItem(SESSION_PLACE_STORAGE_KEY, JSON.stringify(places))
      } catch {
        // Why: a storage failure must not undo the on-screen choice; it still files this card.
      }
    }
  }
}

type SessionPlaceState = SessionPlaces & {
  loaded: boolean
  load: () => void
  /** Remember (or forget) where this conversation files its work. */
  setPlace: (sourceKey: string, next: SessionPlaceChoice | null) => void
  /** A folder chosen for "Save files to"; the last three come back as chips. */
  rememberFolder: (path: string) => void
}

export function createSessionPlaceStore(storage: SessionPlaceStorage) {
  return create<SessionPlaceState>((set, get) => ({
    ...emptySessionPlaces(),
    loaded: false,
    load: () => {
      if (get().loaded) {
        return
      }
      set({ ...storage.load(), loaded: true })
    },
    setPlace: (sourceKey, next) => {
      const { places, recentFolders } = get()
      const updated = setSessionPlace({ places, recentFolders }, sourceKey, next)
      set(updated)
      storage.save(updated)
    },
    rememberFolder: (path) => {
      const { places, recentFolders } = get()
      const updated = rememberRecentFolder({ places, recentFolders }, path)
      set(updated)
      storage.save(updated)
    }
  }))
}

export const useSessionPlaces = createSessionPlaceStore(createLocalSessionPlaceStorage())

function useLoadedSessionPlaces(): void {
  const loaded = useSessionPlaces((state) => state.loaded)
  const load = useSessionPlaces((state) => state.load)
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [load, loaded])
}

/** The place chosen for this conversation, or null when the folder's own place applies. */
export function useSessionPlace(sourceKey: string | null): SessionPlaceChoice | null {
  useLoadedSessionPlaces()
  return useSessionPlaces((state) => (sourceKey ? (state.places[sourceKey] ?? null) : null))
}

export function useRecentFolders(): readonly string[] {
  useLoadedSessionPlaces()
  return useSessionPlaces((state) => state.recentFolders)
}

/** The same answer outside React, for the code that files a card as it is created. */
export function readSessionPlaceChoice(sourceKey: string | null): SessionPlaceChoice | null {
  if (!sourceKey) {
    return null
  }
  useSessionPlaces.getState().load()
  return useSessionPlaces.getState().places[sourceKey] ?? null
}
