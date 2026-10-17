// The one cache and read scheduler behind every goal / to-do surface: the Goals & to-dos view,
// the progress badge on each Conversations row, and the session info panel. Each surface
// registers the sessions it wants read; the union is scheduled once, so a session shown in
// three places is still read at most once per revision, and never faster than the throttle.

import { readGoalsTodosDetails, type GoalsTodosTranscriptRef } from './goals-todos-reader'
import type { GoalsTodosDetails } from './goals-todos-rows'

export type GoalsTodosReadRequest = {
  key: string
  /** Changes whenever the session's hook status does; an unchanged revision is never re-read. */
  revision: string
  ref: GoalsTodosTranscriptRef
}

/** A busy session pings many times a minute; its transcript is re-read at most this often. */
export const GOALS_TODOS_REREAD_MIN_MS = 15_000
export const GOALS_TODOS_MAX_CONCURRENT_READS = 2
const DETAILS_CACHE_MAX = 200

type CachedDetails = { revision: string; details: GoalsTodosDetails; at: number }

const EMPTY_DETAILS: GoalsTodosDetails = {
  goal: null,
  todos: [],
  source: 'none',
  lastMessageAt: null
}

// Why module scope: reopening a surface shows what was read last time instead of blank rows.
const detailsCache = new Map<string, CachedDetails>()
const consumers = new Map<symbol, readonly GoalsTodosReadRequest[]>()
const listeners = new Set<() => void>()
let latest = new Map<string, GoalsTodosReadRequest>()
const inflight = new Set<string>()
const queued = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let version = 0

function remember(key: string, value: CachedDetails): void {
  detailsCache.delete(key)
  detailsCache.set(key, value)
  if (detailsCache.size > DETAILS_CACHE_MAX) {
    const oldest = detailsCache.keys().next().value
    if (oldest !== undefined) {
      detailsCache.delete(oldest)
    }
  }
}

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Reads driven only by status changes the app already receives: no interval of its own. A
 * changed session is read once, a burst of pings collapses into one trailing read, and at
 * most two reads run at a time across every surface.
 */
function pump(): void {
  for (const key of queued) {
    if (inflight.size >= GOALS_TODOS_MAX_CONCURRENT_READS) {
      return
    }
    queued.delete(key)
    const request = latest.get(key)
    if (!request) {
      continue
    }
    inflight.add(key)
    void readGoalsTodosDetails(request.ref)
      .catch((): GoalsTodosDetails => EMPTY_DETAILS)
      .then((details) => remember(key, { revision: request.revision, details, at: Date.now() }))
      .finally(() => {
        inflight.delete(key)
        notify()
        const next = latest.get(key)
        if (next) {
          consider(next)
        }
        pump()
      })
  }
}

function consider(request: GoalsTodosReadRequest): void {
  const { key } = request
  const cached = detailsCache.get(key)
  if (
    cached?.revision === request.revision ||
    inflight.has(key) ||
    queued.has(key) ||
    timers.has(key)
  ) {
    return
  }
  const wait = cached ? GOALS_TODOS_REREAD_MIN_MS - (Date.now() - cached.at) : 0
  if (wait <= 0) {
    queued.add(key)
    return
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const next = latest.get(key)
      if (next) {
        consider(next)
        pump()
      }
    }, wait)
  )
}

function reschedule(): void {
  const merged = new Map<string, GoalsTodosReadRequest>()
  for (const requests of consumers.values()) {
    for (const request of requests) {
      merged.set(request.key, request)
    }
  }
  latest = merged
  // Why: a key no surface wants any more is dropped from the queue and its trailing timer.
  for (const key of queued) {
    if (!merged.has(key)) {
      queued.delete(key)
    }
  }
  for (const [key, timer] of timers) {
    if (!merged.has(key)) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }
  for (const request of merged.values()) {
    consider(request)
  }
  pump()
}

/** Registers one surface's wanted sessions; the returned handle updates or withdraws them. */
export function registerGoalsTodosConsumer(): {
  update: (requests: readonly GoalsTodosReadRequest[]) => void
  dispose: () => void
} {
  const id = Symbol('goals-todos-consumer')
  return {
    update: (requests) => {
      consumers.set(id, requests)
      reschedule()
    },
    dispose: () => {
      if (consumers.delete(id)) {
        reschedule()
      }
    }
  }
}

export function subscribeGoalsTodos(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Bumps on every completed read; a snapshot for surfaces that read many keys at once. */
export function goalsTodosVersion(): number {
  return version
}

/** The last read for one session, or null before any read finished. Stable between reads. */
export function cachedGoalsTodosDetails(key: string): GoalsTodosDetails | null {
  return detailsCache.get(key)?.details ?? null
}

/** Test seam: forget every read, request and timer. */
export function resetGoalsTodosStoreForTests(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer)
  }
  timers.clear()
  queued.clear()
  inflight.clear()
  consumers.clear()
  detailsCache.clear()
  latest = new Map()
  version = 0
}

/** Test seam: seed one session's read as if it had just completed. */
export function seedGoalsTodosDetailsForTests(key: string, details: GoalsTodosDetails): void {
  remember(key, { revision: 'seed', details, at: Date.now() })
  notify()
}
