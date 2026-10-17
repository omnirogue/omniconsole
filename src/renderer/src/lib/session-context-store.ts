import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from './console-account-scope'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import {
  validateSessionContext,
  type SessionContextAttachment
} from '../../../shared/session-context-attachments'
import { moveSessionContextRemovals, setSessionContextRemovals } from './session-context-removals'
import {
  parseSessionContextEntries,
  serializeSessionContextEntries,
  withSessionContextEntry,
  type LaunchContextMeta,
  type LaunchContextMetaMap,
  type SessionContextEntries as Entries,
  type SessionContextState
} from './session-context-storage'

const STORAGE_KEY = 'omni.session-context.v1'
const NEEDS_REPAIR =
  'This session’s saved context needs repair before it can be changed. Its original data is kept.'
const EMPTY: readonly SessionContextAttachment[] = Object.freeze([])
let entries: Entries | undefined
let meta: LaunchContextMetaMap = {}
let listening = false
let readError: string | undefined
let rawEntries: Record<string, unknown> = {}
const invalidKeys = new Set<string>()
const listeners = new Set<() => void>()
const launches = new Set<string>()
const migratedKeys = new Map<string, string>()

function currentKey(key: string): string {
  const seen = new Set<string>()
  while (migratedKeys.has(key) && !seen.has(key)) {
    seen.add(key)
    key = migratedKeys.get(key)!
  }
  return key
}

function readEntries(): Entries {
  if (entries) {
    return entries
  }
  entries = {}
  meta = {}
  invalidKeys.clear()
  readError = undefined
  try {
    const read = parseSessionContextEntries(localStorage.getItem(STORAGE_KEY))
    rawEntries = read.raw
    entries = read.entries
    meta = read.meta
    read.invalidKeys.forEach((key) => invalidKeys.add(key))
  } catch {
    readError = 'Saved session context could not be read. Your saved data has not been replaced.'
  }
  return entries
}

function writeEntries(next: Entries, migrations?: Map<string, string>, nextMeta = meta): void {
  if (readError) {
    throw new Error(readError)
  }
  const preserved = Object.fromEntries([...invalidKeys].map((key) => [key, rawEntries[key]]))
  const stored = serializeSessionContextEntries(next, nextMeta)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...preserved, ...stored }))
  } catch (error) {
    throw new Error('Session context could not be saved. Free some app storage and try again.', {
      cause: error
    })
  }
  for (const [from, to] of migrations ?? []) {
    migratedKeys.set(from, to)
  }
  entries = next
  meta = Object.fromEntries(Object.entries(nextMeta).filter(([key]) => Object.hasOwn(next, key)))
  for (const listener of listeners) {
    listener()
  }
}

function scopedKey(kind: string, host: string | null, identity: string | null): string {
  return JSON.stringify([selectConsoleAccountScope(useAppStore.getState()), kind, host, identity])
}

export function launchSessionContextKey(worktreeId: string | null): string {
  return scopedKey(
    'launch',
    getAgentDetectionTargetKeyForWorktree(useAppStore.getState(), worktreeId) ?? 'unresolved',
    worktreeId
  )
}

function tabContextKey(tabId: string, worktreeId: string | null): string {
  return scopedKey(
    'tab',
    getAgentDetectionTargetKeyForWorktree(useAppStore.getState(), worktreeId) ?? 'unresolved',
    tabId
  )
}

export function sessionContextKey(session: SidebarSession): string {
  if (!session.sessionKey && !session.paneKey && session.tabId) {
    return tabContextKey(session.tabId, session.worktreeId)
  }
  return scopedKey(
    'session',
    session.hostId,
    session.sessionKey ?? session.paneKey ?? session.rowKey
  )
}

/** Move the provisional tab binding once the provider identity is known. Never reuse it for another agent. */
function reconcileBindings(): void {
  const current = readEntries()
  if (!Object.keys(current).length) {
    return
  }
  let next: Entries | undefined
  const migrations = new Map<string, string>()
  for (const session of buildPaneSessions(useAppStore.getState())) {
    const key = sessionContextKey(session)
    const candidates = [
      ...(session.tabId ? [tabContextKey(session.tabId, session.worktreeId)] : []),
      ...(session.folderKeyMigration
        ? [scopedKey('session', session.hostId, session.folderKeyMigration.from)]
        : []),
      ...(session.paneKey && session.sessionKey
        ? [scopedKey('session', session.hostId, session.paneKey)]
        : [])
    ]
    for (const from of candidates) {
      const value = (next ?? current)[from]
      if (!value || from === key) {
        continue
      }
      next ??= { ...current }
      next[key] ??= value
      delete next[from]
      migrations.set(from, key)
      moveSessionContextRemovals(from, key)
    }
  }
  if (next) {
    writeEntries(next, migrations)
  }
}

function ensureListening(): void {
  if (listening) {
    return
  }
  listening = true
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) {
      return
    }
    entries = undefined
    for (const listener of listeners) {
      listener()
    }
  })
  useAppStore.subscribe((state, before) => {
    if (
      state.agentStatusByPaneKey === before.agentStatusByPaneKey &&
      state.tabsByWorktree === before.tabsByWorktree &&
      state.unifiedTabsByWorktree === before.unifiedTabsByWorktree &&
      state.sleepingAgentSessionsByPaneKey === before.sleepingAgentSessionsByPaneKey &&
      state.terminalLayoutsByTabId === before.terminalLayoutsByTabId
    ) {
      return
    }
    try {
      reconcileBindings()
    } catch (error) {
      // The next context read/write retries and surfaces this error; preserve the saved binding meanwhile.
      toast.error(error instanceof Error ? error.message : String(error))
    }
  })
}

export function getSessionContext(key: string): readonly SessionContextAttachment[] {
  ensureListening()
  if (!key) {
    return EMPTY
  }
  try {
    if (JSON.parse(key)[0] !== selectConsoleAccountScope(useAppStore.getState())) {
      return EMPTY
    }
  } catch {
    return EMPTY
  }
  return readEntries()[currentKey(key)] ?? EMPTY
}

export function useSessionContext(key: string): readonly SessionContextAttachment[] {
  useAppStore(selectConsoleAccountScope)
  useEffect(() => {
    getSessionContext(key)
    const message =
      readError ??
      (invalidKeys.has(key)
        ? 'This session’s saved context could not be read. The original data is kept.'
        : undefined)
    if (message) {
      toast.error(message, { id: 'session-context-storage-read' })
    }
  }, [key])
  return useSyncExternalStore(subscribeSessionContext, () => getSessionContext(key))
}

export function subscribeSessionContext(listener: () => void): () => void {
  ensureListening()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A launcher entry's saved settings (see session-context-storage.ts), when it has any. */
export function sessionContextMeta(key: string): LaunchContextMeta | undefined {
  readEntries()
  return meta[currentKey(key)]
}

/** Writes all entries and launcher settings at once; `change` returns new maps or undefined. */
export function changeSessionContextEntries(
  change: (current: Readonly<SessionContextState>) => SessionContextState | undefined
): void {
  ensureListening()
  const current = readEntries()
  if (readError) {
    throw new Error(readError)
  }
  const next = change({ entries: current, meta })
  if (!next) {
    return
  }
  if ([...invalidKeys].some((key) => Object.hasOwn(next.entries, key))) {
    throw new Error(NEEDS_REPAIR)
  }
  writeEntries(next.entries, undefined, next.meta)
}

export async function setSessionContext(
  key: string,
  items: readonly SessionContextAttachment[]
): Promise<void> {
  ensureListening()
  if (JSON.parse(key)[0] !== selectConsoleAccountScope(useAppStore.getState())) {
    throw new Error('The account changed. Reopen session context and try again.')
  }
  validateSessionContext(items)
  readEntries()
  key = currentKey(key)
  if (invalidKeys.has(key)) {
    throw new Error(NEEDS_REPAIR)
  }
  const copies = items.map((item) => ({ ...item }))
  const next = withSessionContextEntry({ entries: readEntries(), meta }, key, copies)
  writeEntries(next.entries, undefined, next.meta)
}

export function sessionContextForSource(
  sourceKey: string,
  hostId?: string
): readonly SessionContextAttachment[] {
  const session = buildPaneSessions(useAppStore.getState()).find(
    (candidate) =>
      (candidate.paneKey === sourceKey ||
        candidate.tabId === sourceKey ||
        candidate.structuredSessionId === sourceKey) &&
      (!hostId || candidate.hostId === hostId)
  )
  return session ? getSessionContext(sessionContextKey(session)) : EMPTY
}

/** Persist synchronously when a launcher knows the new identity, before any prompt is sent. */
export function bindSessionContext(
  tabId: string,
  worktreeId: string | null,
  items: readonly SessionContextAttachment[],
  removed: readonly string[] = []
): void {
  if (!items.length && !removed.length) {
    return
  }
  ensureListening()
  validateSessionContext(items)
  launches.add(tabId)
  setSessionContextRemovals(tabContextKey(tabId, worktreeId), removed)
  writeEntries({
    ...readEntries(),
    [tabContextKey(tabId, worktreeId)]: items.map((item) => ({ ...item }))
  })
  reconcileBindings()
}

export function sessionContextLaunchBinding(
  items: readonly SessionContextAttachment[],
  worktreeId: string | null,
  removed: readonly string[] = []
): (tabId: string) => void {
  const scope = selectConsoleAccountScope(useAppStore.getState())
  return (tabId) => {
    if (selectConsoleAccountScope(useAppStore.getState()) !== scope) {
      throw new Error('The account changed before session context could be saved.')
    }
    bindSessionContext(tabId, worktreeId, items, removed)
  }
}

export function consumeSessionContextLaunch(tabId: string): boolean {
  return launches.delete(tabId)
}
