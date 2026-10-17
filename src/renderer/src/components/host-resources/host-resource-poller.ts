import { useEffect, useSyncExternalStore } from 'react'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import type { HostResourceReading } from '../../../../shared/host-resource-model'

/** Every surface shares one 30 s poll over the union of hosts they show. */
export const HOST_RESOURCE_POLL_MS = 30_000
// Why a quick follow-up: a host still `checking` after main's short wait is read in the background.
const FOLLOW_UP_MS = 5_000

const readings = new Map<string, HostResourceReading>()
const interest = new Map<string, number>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, HostResourceReading> = new Map()
// Why a stored clock: ages are computed as of the last poll, never by reading time during render.
let snapshotAt = 0
let stopPolling: (() => void) | null = null
let pending: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let pendingRepoll = false

function emit(): void {
  snapshot = new Map(readings)
  snapshotAt = Date.now()
  for (const listener of listeners) {
    listener()
  }
}

async function poll(): Promise<void> {
  const keys = [...interest.keys()]
  const read = window.api?.memory?.getHostResources
  if (!isWindowVisible() || keys.length === 0 || !read) {
    return
  }
  if (inFlight) {
    pendingRepoll = true
    return
  }
  inFlight = true
  try {
    const result = await read(keys)
    for (const reading of result) {
      readings.set(reading.hostKey, reading)
    }
    emit()
    if (result.some((reading) => reading.state === 'checking')) {
      schedule(FOLLOW_UP_MS)
    }
  } catch {
    // Why silent: an IPC failure leaves the last readings; the badge shows a dash for unknowns.
  } finally {
    inFlight = false
    if (pendingRepoll) {
      pendingRepoll = false
      schedule(0)
    }
  }
}

function schedule(delayMs: number): void {
  if (!isWindowVisible() || interest.size === 0) {
    return
  }
  if (pending) {
    if (delayMs !== 0) {
      return
    }
    clearTimeout(pending)
  }
  pending = setTimeout(() => {
    pending = null
    void poll()
  }, delayMs)
}

function pausePendingPoll(): void {
  if (!isWindowVisible() && pending) {
    clearTimeout(pending)
    pending = null
  }
}

function retain(keys: readonly string[]): () => void {
  let added = false
  for (const key of keys) {
    const count = interest.get(key) ?? 0
    interest.set(key, count + 1)
    added ||= count === 0
  }
  if (added) {
    // Why 0 ms: headers mounting in one render share a single request.
    schedule(0)
  }
  if (!stopPolling) {
    document.addEventListener('visibilitychange', pausePendingPoll)
  }
  stopPolling ??= installWindowVisibilityInterval({
    run: () => void poll(),
    runOnVisible: () => schedule(0),
    intervalMs: HOST_RESOURCE_POLL_MS
  })
  return () => {
    for (const key of keys) {
      const count = (interest.get(key) ?? 1) - 1
      if (count <= 0) {
        interest.delete(key)
      } else {
        interest.set(key, count)
      }
    }
    if (interest.size === 0) {
      document.removeEventListener('visibilitychange', pausePendingPoll)
      stopPolling?.()
      stopPolling = null
      if (pending) {
        clearTimeout(pending)
      }
      pending = null
      pendingRepoll = false
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = (): ReadonlyMap<string, HostResourceReading> => snapshot
const getSnapshotAt = (): number => snapshotAt

/** When the readings were last refreshed; the "now" every age is measured against. */
export function useHostResourceClock(): number {
  return useSyncExternalStore(subscribe, getSnapshotAt, getSnapshotAt)
}

/** Readings for `hostKeys`, polled every 30 s while mounted; pass only connected hosts. */
export function useHostResourceReadings(
  hostKeys: readonly string[]
): ReadonlyMap<string, HostResourceReading> {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const joined = [...new Set(hostKeys)].sort().join('\n')
  useEffect(() => (joined ? retain(joined.split('\n')) : undefined), [joined])
  return current
}

export function useHostResourceReading(hostKey: string | null): HostResourceReading | null {
  const all = useHostResourceReadings(hostKey ? [hostKey] : [])
  return hostKey ? (all.get(hostKey) ?? null) : null
}
