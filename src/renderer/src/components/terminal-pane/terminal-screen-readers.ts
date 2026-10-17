import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/**
 * Each mounted terminal pane's current-screen reader, by pane key, so an answer sent from outside
 * the pane (Needs you) can still confirm Claude's selector closed, as the pane's own card does.
 */
const readers = new Map<string, () => string | null>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function useRegisterTerminalScreenReader(paneKey: string, read: () => string | null): void {
  const latest = useRef(read)
  useLayoutEffect(() => {
    latest.current = read
  }, [read])
  // Why one stable reader per pane: callers pass a fresh closure every render.
  useEffect(() => {
    const stable = (): string | null => latest.current()
    readers.set(paneKey, stable)
    notify()
    return () => {
      if (readers.get(paneKey) === stable) {
        readers.delete(paneKey)
        notify()
      }
    }
  }, [paneKey])
}

/** The pane's reader while it is mounted; undefined otherwise. */
export function useTerminalScreenReader(paneKey: string): (() => string | null) | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => readers.get(paneKey)
  )
}

/** The pane's reader outside React (an answer relayed from main); undefined when unmounted. */
export function readTerminalScreenReader(paneKey: string): (() => string | null) | undefined {
  return readers.get(paneKey)
}
