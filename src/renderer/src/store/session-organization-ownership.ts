import { create } from 'zustand'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import type {
  OrganizationKeyState,
  OrganizationOwnership,
  OrganizationOwnershipField,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import {
  adoptedOrganizationKeyState,
  emptyOrganizationKeyState,
  isEmptyOrganizationKeyState,
  migrateOrganizationKeyState,
  organizationKeyStatesAfter,
  parseOrganizationKeyState,
  withSyncStamp,
  type OwnershipSyncStamp
} from '../../../shared/session-organization-ownership'

const KEY = 'omni.session-organization-ownership.v1'

export type OwnershipMirror = Readonly<Record<string, OrganizationKeyState>>

type OwnershipMirrorState = {
  keys: OwnershipMirror
  scope: string | null
  load: () => void
  stateFor: (key: string) => OrganizationKeyState
  /** An agent's own untouched change still holding the field, or null (then it is the person's). */
  ownedField: (key: string, field: OrganizationOwnershipField) => OrganizationOwnership | null
  applyRecord: (record: OrganizationRecord) => void
  attachSyncStamp: (stamp: OwnershipSyncStamp) => boolean
  migrateKey: (from: string, to: string, placementFrom: boolean) => boolean
  /** Main's copy of `keys` (of every key when `complete`); the stamps main lacks, to send again. */
  adopt: (keys: OwnershipMirror, complete: boolean) => OwnershipSyncStamp[]
}

function parseMirror(raw: string | null): Record<string, OrganizationKeyState> {
  const keys: Record<string, OrganizationKeyState> = {}
  const saved = raw ? (JSON.parse(raw) as { version?: unknown; keys?: unknown }) : null
  if (saved?.version !== 1 || !saved.keys || typeof saved.keys !== 'object') {
    return keys
  }
  for (const [key, value] of Object.entries(saved.keys as Record<string, unknown>)) {
    const state = parseOrganizationKeyState(value)
    if (state) {
      keys[key] = state
    }
  }
  return keys
}

/**
 * The window's mirror of which placements and titles are still an agent's own untouched change,
 * and which are the person's for good (main's session-organization history is the source of
 * truth; this answers synchronously for the sync hook and the revision check). Per device and
 * account scope, like the batch origins; anything missing here is the person's.
 */
export function createSessionOrganizationOwnershipStore(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
) {
  return create<OwnershipMirrorState>((set, get) => {
    const current = (): OwnershipMirror => {
      if (get().scope !== personalViewStorageKey(KEY)) {
        get().load()
      }
      return get().keys
    }
    const save = (keys: OwnershipMirror): void => {
      if (keys === get().keys) {
        return
      }
      set({ keys })
      try {
        getStorage().setItem(get().scope!, JSON.stringify({ version: 1, keys }))
      } catch {
        // Why keep going: main holds the authoritative copy and the next start reads it back.
      }
    }
    const withStates = (
      keys: OwnershipMirror,
      states: Iterable<[string, OrganizationKeyState]>
    ): OwnershipMirror => {
      const next: Record<string, OrganizationKeyState> = { ...keys }
      for (const [key, state] of states) {
        if (isEmptyOrganizationKeyState(state)) {
          delete next[key]
        } else {
          next[key] = state
        }
      }
      return next
    }
    return {
      keys: {},
      scope: null,
      load: () => {
        const scope = personalViewStorageKey(KEY)
        let keys: Record<string, OrganizationKeyState> = {}
        try {
          keys = parseMirror(getStorage().getItem(scope))
        } catch {
          // Why start empty: main's copy refills it, and until then everything counts as yours.
        }
        set({ keys, scope })
      },
      stateFor: (key) => current()[key] ?? emptyOrganizationKeyState(),
      ownedField: (key, field) => {
        const state = current()[key]
        return state && !state.revocations[field] ? (state.ownership[field] ?? null) : null
      },
      applyRecord: (record) => {
        const keys = current()
        const next = organizationKeyStatesAfter(
          record,
          (key) => keys[key] ?? emptyOrganizationKeyState()
        )
        if (next.size > 0) {
          save(withStates(keys, next))
        }
      },
      attachSyncStamp: ({ key, ...stamp }) => {
        const keys = current()
        const state = keys[key] ?? emptyOrganizationKeyState()
        const next = withSyncStamp(state, stamp)
        if (next === state) {
          return false
        }
        save(withStates(keys, [[key, next]]))
        return true
      },
      migrateKey: (from, to, placementFrom) => {
        const keys = current()
        const carried = keys[from]
        if (from === to || !carried) {
          return false
        }
        const moved = migrateOrganizationKeyState(
          carried,
          keys[to] ?? emptyOrganizationKeyState(),
          placementFrom
        )
        save(
          withStates(keys, [
            [from, emptyOrganizationKeyState()],
            [to, moved]
          ])
        )
        return true
      },
      adopt: (theirs, complete) => {
        const keys = current()
        const names = new Set([...Object.keys(theirs), ...(complete ? Object.keys(keys) : [])])
        const resend: OwnershipSyncStamp[] = []
        const states: [string, OrganizationKeyState][] = []
        for (const key of names) {
          const adopted = adoptedOrganizationKeyState(
            keys[key] ?? emptyOrganizationKeyState(),
            parseOrganizationKeyState(theirs[key]) ?? emptyOrganizationKeyState()
          )
          states.push([key, adopted.state])
          resend.push(...adopted.resend.map((stamp) => ({ key, ...stamp })))
        }
        save(withStates(keys, states))
        return resend
      }
    }
  })
}

export const useSessionOrganizationOwnership = createSessionOrganizationOwnershipStore()
