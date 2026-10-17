import { useSyncExternalStore } from 'react'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import type { RoutineTeamLink } from './routine-team-conversion'

const listeners = new Set<() => void>()
const cache = new Map<string, Record<string, RoutineTeamLink>>()
const storageKey = (): string => personalViewStorageKey('omni.routine-team-links.v1')
export const TEAM_ROUTINES_CHANGED = 'omni:team-routines-changed'

function links(key: string): Record<string, RoutineTeamLink> {
  let result = cache.get(key)
  if (!result) {
    result = {}
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
      if (raw && typeof raw === 'object') {
        for (const [id, value] of Object.entries(raw)) {
          if (
            value &&
            typeof value.teamRoutineId === 'string' &&
            typeof value.convertedAt === 'string'
          ) {
            result[id] = {
              ...value,
              // Old receipts were created without enabling the team routine.
              state: ['pending', 'enabled', 'linked'].includes(value.state)
                ? value.state
                : 'pending'
            }
          }
        }
      }
    } catch {
      /* Keep the in-memory receipt if storage is unavailable. */
    }
    cache.set(key, result)
  }
  return result
}
export function saveRoutineTeamLink(id: string, link: RoutineTeamLink, key = storageKey()): void {
  const next = { ...links(key), [id]: link }
  cache.set(key, next)
  for (const listener of listeners) {
    listener()
  }
  window.dispatchEvent(new Event(TEAM_ROUTINES_CHANGED))
  localStorage.setItem(key, JSON.stringify(next))
}
export function routineTeamLinkStorageKey(): string {
  return storageKey()
}
export function readRoutineTeamLink(id: string): RoutineTeamLink | undefined {
  return links(storageKey())[id]
}
export function useRoutineTeamLink(id: string): RoutineTeamLink | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => readRoutineTeamLink(id)
  )
}
export function viewTeamRoutine(id: string): void {
  window.dispatchEvent(new CustomEvent('omni:view-team-routine', { detail: id }))
}
