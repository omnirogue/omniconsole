import { create } from 'zustand'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import {
  emptySessionBatchOrigins,
  migrateSessionBatchOrigin,
  parseSessionBatchOrigins,
  recordSessionBatchFolder,
  recordSessionBatchSession,
  type SessionBatchOrigins
} from '@/lib/session-batch-origins'
import type { SessionBatchOriginRequest } from '../../../shared/session-batch-origin'

const KEY = 'omni.session-batch-origins.v1'

type SessionBatchOriginRecordRequest = Exclude<
  SessionBatchOriginRequest,
  { kind: 'listBatchOrigins' }
>

type BatchOriginState = {
  data: SessionBatchOrigins
  scope: string | null
  load: () => void
  record: (request: SessionBatchOriginRecordRequest) => void
  /** What main's steward reads (`listBatchOrigins`), for the current personal view. */
  read: () => SessionBatchOrigins
  migrateSessionKey: (from: string, to: string) => void
}

/**
 * Which launch request made each batch folder, per device (see shared/session-batch-origin.ts).
 * Deliberately outside folder metadata and account sync; a folder missing here is the person's.
 */
export function createSessionBatchOriginsStore(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage,
  now: () => number = Date.now
) {
  const current = (get: () => BatchOriginState): SessionBatchOrigins => {
    if (get().scope !== personalViewStorageKey(KEY)) {
      get().load()
    }
    return get().data
  }
  const save = (
    set: (partial: Partial<BatchOriginState>) => void,
    get: () => BatchOriginState,
    data: SessionBatchOrigins
  ): void => {
    if (data === get().data) {
      return
    }
    set({ data })
    try {
      getStorage().setItem(get().scope!, JSON.stringify(data))
    } catch {
      // Why keep going: an origin is advisory; losing one only means the folder reads as the person's.
    }
  }
  return create<BatchOriginState>((set, get) => ({
    data: emptySessionBatchOrigins(),
    scope: null,
    load: () => {
      const scope = personalViewStorageKey(KEY)
      let data = emptySessionBatchOrigins()
      try {
        const raw = getStorage().getItem(scope)
        data = raw === null ? data : parseSessionBatchOrigins(JSON.parse(raw))
      } catch {
        // Why start empty: unreadable origins fall back to "the person's", the safe default.
      }
      set({ data, scope })
    },
    record: (request) => {
      const data = current(get)
      save(
        set,
        get,
        request.kind === 'recordBatchFolder'
          ? recordSessionBatchFolder(data, request.origin)
          : recordSessionBatchSession(data, request.sessionKey, request.origin, now())
      )
    },
    read: () => current(get),
    migrateSessionKey: (from, to) => {
      save(set, get, migrateSessionBatchOrigin(current(get), from, to))
    }
  }))
}

export const useSessionBatchOrigins = createSessionBatchOriginsStore()
