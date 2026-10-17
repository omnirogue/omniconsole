import { useSyncExternalStore } from 'react'
import type { WorkRow } from '../../../../shared/backoffice-work-views'

const READ_STATE_KEY = 'omni.inbox.read.v2'
type ReadState = Record<string, number>
const listeners = new Set<() => void>()
const volatileState = new Map<string, ReadState>()
let revision = 0

function changed() {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

function storageChanged(event: StorageEvent) {
  if (event.key === null) {
    volatileState.clear()
  } else if (event.key.startsWith(`${READ_STATE_KEY}:`)) {
    volatileState.delete(event.key)
  } else {
    return
  }
  changed()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', storageChanged)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('storage', storageChanged)
    }
  }
}

function readState(key: string): ReadState {
  if (volatileState.has(key)) {
    return volatileState.get(key)!
  }
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.fromEntries(
        Object.entries(raw).filter(
          ([, value]) => typeof value === 'number' && Number.isFinite(value)
        )
      )
    }
  } catch {
    // Read controls remain usable when browser storage is unavailable.
  }
  return volatileState.get(key) ?? {}
}

function writeState(key: string, value: ReadState) {
  volatileState.set(key, value)
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    volatileState.delete(key)
  } catch {
    // A local read preference never changes delivery, ownership or approval.
  }
  changed()
}

export function inboxRowActivity(row: WorkRow): number {
  if (row.message) {
    const message = row.message
    return (
      Math.max(
        message.created_at ?? 0,
        message.delivered_at ?? 0,
        message.replied_at ?? 0,
        message.reply?.created_at ?? 0
      ) * 1000
    )
  }
  const time = Date.parse(row.thread?.updated ?? row.updatedAt ?? '')
  return Number.isFinite(time) ? time : 0
}

export function inboxRowCanBeUnread(row: WorkRow, viewer: string | null): boolean {
  if (!viewer) {
    return false
  }
  if (row.message) {
    const message = row.message
    if (message.state === 'expired') {
      return false
    }
    return (
      message.recipient_employee_id === viewer ||
      (message.sender_employee_id === viewer && Boolean(message.reply))
    )
  }
  if (row.thread) {
    const thread = row.thread
    return (
      (thread.recipient_employee_id === viewer ||
        (thread.author_employee_id === viewer && row.repliesWaiting > 0)) &&
      (thread.state !== 'resolved' || row.repliesWaiting > 0)
    )
  }
  return false
}

/** Only local reading preferences live here; conversation records remain in Work. */
export function useInboxReadState(scope: string, viewer: string | null) {
  useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0
  )
  const key = `${READ_STATE_KEY}:${JSON.stringify([scope, viewer])}`
  const state = readState(key)
  const isUnread = (row: WorkRow) =>
    inboxRowCanBeUnread(row, viewer) &&
    (state[row.key] === undefined || inboxRowActivity(row) > state[row.key]!)
  const markRead = (row: WorkRow) => {
    if (viewer) {
      writeState(key, { ...readState(key), [row.key]: inboxRowActivity(row) })
    }
  }
  const toggle = (row: WorkRow) => {
    if (!viewer) {
      return
    }
    if (isUnread(row)) {
      markRead(row)
    } else {
      const next = { ...readState(key) }
      delete next[row.key]
      writeState(key, next)
    }
  }
  return { isUnread, markRead, toggle, canMark: (row: WorkRow) => inboxRowCanBeUnread(row, viewer) }
}
