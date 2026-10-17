import { useSyncExternalStore } from 'react'
import {
  launchManifestReport,
  type LaunchManifest,
  type LaunchManifestRecord
} from '../../../shared/launch-manifest'

/**
 * What each session was launched with (launch-manifest.ts), by tab, so Session details can show
 * the same list the review panel showed. Per device, like the session's context entry; no
 * document bodies or instruction text are kept.
 */
const STORAGE_KEY = 'omni.session-launch-record.v1'
const MAX_RECORDS = 400
const listeners = new Set<() => void>()
let cache: Record<string, LaunchManifestRecord> | undefined

function read(): Record<string, LaunchManifestRecord> {
  if (cache) {
    return cache
  }
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    cache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, LaunchManifestRecord>)
        : {}
  } catch {
    cache = {}
  }
  return cache
}

export function recordSessionLaunch(tabId: string, manifest: LaunchManifest): void {
  const next = {
    ...read(),
    [tabId]: { ...launchManifestReport(manifest), launchedAt: Date.now() }
  }
  const kept = Object.entries(next)
    .sort(([, a], [, b]) => b.launchedAt - a.launchedAt)
    .slice(0, MAX_RECORDS)
  cache = Object.fromEntries(kept)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Why ignored: the session already started with this list; losing the record only hides it later.
  }
  for (const listener of listeners) {
    listener()
  }
}

/** Adds keeping the launch list to a launch's `onSessionCreated`. */
export function recordingSessionLaunch(
  onSessionCreated: ((tabId: string) => void) | undefined,
  manifest: LaunchManifest | undefined
): ((tabId: string) => void) | undefined {
  if (!manifest) {
    return onSessionCreated
  }
  return (tabId) => {
    recordSessionLaunch(tabId, manifest)
    onSessionCreated?.(tabId)
  }
}

export function useSessionLaunchRecord(tabId: string | undefined): LaunchManifestRecord | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => (tabId ? (read()[tabId] ?? null) : null)
  )
}
