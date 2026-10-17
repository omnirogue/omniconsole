import { useSyncExternalStore } from 'react'

// Why: the workspace list is virtualized and owns the row model; the header's
// collapse/expand-all control only needs the keys, so they are published here
// instead of lifting the whole row model out of the list.
let currentKeys: readonly string[] = []
const listeners = new Set<() => void>()

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

export function publishSidebarCollapsibleGroupKeys(keys: readonly string[]): void {
  if (sameKeys(currentKeys, keys)) {
    return
  }
  currentKeys = keys
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): readonly string[] {
  return currentKeys
}

export function useSidebarCollapsibleGroupKeys(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Why a second channel: session-worktree group headers start collapsed, so stored membership
// means "open" for them and bulk collapse/expand must treat them with the opposite polarity.
let currentDefaultCollapsedKeys: readonly string[] = []
const defaultCollapsedListeners = new Set<() => void>()

export function publishSidebarDefaultCollapsedGroupKeys(keys: readonly string[]): void {
  if (sameKeys(currentDefaultCollapsedKeys, keys)) {
    return
  }
  currentDefaultCollapsedKeys = keys
  for (const listener of defaultCollapsedListeners) {
    listener()
  }
}

function subscribeDefaultCollapsed(listener: () => void): () => void {
  defaultCollapsedListeners.add(listener)
  return () => {
    defaultCollapsedListeners.delete(listener)
  }
}

function getDefaultCollapsedSnapshot(): readonly string[] {
  return currentDefaultCollapsedKeys
}

export function useSidebarDefaultCollapsedGroupKeys(): readonly string[] {
  return useSyncExternalStore(
    subscribeDefaultCollapsed,
    getDefaultCollapsedSnapshot,
    getDefaultCollapsedSnapshot
  )
}

/**
 * Stored collapse keys after a bulk collapse (`collapse`) or expand. Session section headers
 * flip with the bulk action; open-polarity lineage folds are kept either way, since the section
 * or repo header above them already hides or shows them and they cannot be rebuilt once dropped.
 */
export function getBulkCollapsedGroupKeys(args: {
  collapse: boolean
  collapsibleGroupKeys: readonly string[]
  defaultCollapsedKeys: readonly string[]
  storedCollapsedGroups: ReadonlySet<string>
  isOpenPolarityKey: (key: string) => boolean
}): string[] {
  const keptOpen = [...args.storedCollapsedGroups].filter(
    (key) => args.isOpenPolarityKey(key) && !args.defaultCollapsedKeys.includes(key)
  )
  return args.collapse
    ? [...args.collapsibleGroupKeys, ...keptOpen]
    : [...args.defaultCollapsedKeys, ...keptOpen]
}
