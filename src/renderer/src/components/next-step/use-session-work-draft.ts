import { useCallback, useEffect, useState, useSyncExternalStore, type SetStateAction } from 'react'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import type { NextStepSubject } from './next-step-subject'

const listeners = new Set<() => void>()
const cache = new Map<string, { raw: string | null; value: unknown }>()

export function sessionWorkDraftKey(subject: NextStepSubject, editor: string): string {
  const identity =
    subject.kind === 'session'
      ? [
          subject.session.hostId,
          subject.session.worktreeId,
          subject.session.sessionKey ?? subject.session.rowKey
        ]
      : subject.kind === 'card'
        ? [subject.item.task_id]
        : [subject.detail.thread.id, subject.viewer]
  return personalViewStorageKey(
    `omni.session-work-draft.v1:${JSON.stringify([subject.kind, identity, editor])}`
  )
}

export function readSessionWorkDraft<T>(key: string): T | undefined {
  const raw = localStorage.getItem(key)
  const previous = cache.get(key)
  if (previous?.raw === raw) {
    return previous.value as T | undefined
  }
  let value: T | undefined
  try {
    value = raw === null ? undefined : (JSON.parse(raw) as T)
  } catch {
    value = undefined
  }
  cache.set(key, { raw, value })
  return value
}

export function writeSessionWorkDraft<T>(key: string, value: T | undefined): void {
  // Persist before publishing: a failed write must not masquerade as a saved draft.
  if (value === undefined) {
    localStorage.removeItem(key)
  } else {
    const raw = JSON.stringify(value)
    if (localStorage.getItem(key) === raw) {
      return
    }
    localStorage.setItem(key, raw)
  }
  cache.delete(key)
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/** Editor state only; admission receipts remain owned by the durable dispatch service. */
export function useSessionWorkDraft<T>(subject: NextStepSubject, editor: string, initial: () => T) {
  const key = sessionWorkDraftKey(subject, editor)
  const migrationKey =
    subject.kind === 'session' && subject.session.folderKeyMigration
      ? sessionWorkDraftKey(
          {
            ...subject,
            session: { ...subject.session, sessionKey: subject.session.folderKeyMigration.from }
          },
          editor
        )
      : null
  const saved = useSyncExternalStore(
    subscribe,
    () =>
      readSessionWorkDraft<T>(key) ??
      (migrationKey ? readSessionWorkDraft<T>(migrationKey) : undefined)
  )
  useEffect(() => {
    if (!migrationKey || migrationKey === key) {
      return
    }
    const previous = readSessionWorkDraft<T>(migrationKey)
    if (previous === undefined) {
      return
    }
    if (readSessionWorkDraft<T>(key) === undefined) {
      writeSessionWorkDraft(key, previous)
    }
    writeSessionWorkDraft(migrationKey, undefined)
  }, [key, migrationKey])
  const [fallback, setFallback] = useState(() => ({ key, value: initial() }))
  if (fallback.key !== key) {
    setFallback({ key, value: initial() })
  }
  const value = saved ?? fallback.value
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      const current = readSessionWorkDraft<T>(key) ?? fallback.value
      writeSessionWorkDraft(
        key,
        typeof next === 'function' ? (next as (value: T) => T)(current) : next
      )
    },
    [key, fallback.value]
  )
  const clear = useCallback(() => writeSessionWorkDraft(key, undefined), [key])
  return [value, setValue, clear, saved !== undefined] as const
}
