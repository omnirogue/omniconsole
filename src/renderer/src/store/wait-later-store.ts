import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'
import { useEffect } from 'react'
import { create } from 'zustand'
import {
  emptyWaitLater,
  finishedMarks,
  parseWaitLater,
  pruneWaitLater,
  returnedMarks,
  setFinished,
  setReturned,
  setWaitLater,
  WAIT_LATER_STORAGE_KEY,
  waitingKeys,
  type WaitLater
} from '@/lib/wait-later'

export type WaitLaterStorage = {
  load(): WaitLater
  save(view: WaitLater): void
}

// Per-device presentation, like session-sidebar-view-storage; never sent to a host.
export function createLocalWaitLaterStorage(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage
): WaitLaterStorage {
  return {
    load() {
      const raw = readPersonalView(getStorage(), WAIT_LATER_STORAGE_KEY)
      return raw === null ? emptyWaitLater() : parseWaitLater(JSON.parse(raw))
    },
    save(view) {
      getStorage().setItem(personalViewStorageKey(WAIT_LATER_STORAGE_KEY), JSON.stringify(view))
    }
  }
}

type WaitLaterState = {
  view: WaitLater
  loaded: boolean
  /** Keys waiting as of the last tick; re-derived when a wait passes. */
  waiting: ReadonlySet<string>
  /** Panes called finished, with the time of the call. */
  finished: ReadonlyMap<string, number>
  /** Panes a plan handed back, with the time it ended. */
  returned: ReadonlyMap<string, number>
  load: () => void
  /** Re-check the clock; waits that passed come back on their own. */
  tick: () => void
  /** Returns whether this device could save the change (the view is applied either way). */
  setUntil: (key: string, until: Date | null) => boolean
  setFinished: (key: string, at: Date | null) => void
  /** ↩ Back to me: mark the source row as needing the person again, or clear it when opened. */
  setReturned: (key: string, at: Date | null) => void
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()
const SESSION_SNOOZE_PREFIX = 'conversation:'
const EMPTY_MARKS: ReadonlyMap<string, number> = new Map()

// Why: a ⏳ on a pane is the ledger's `waiting` state; best effort, never awaited, never thrown.
function tellSessionLedger(key: string, waiting: boolean): void {
  if (!key.startsWith('pane:') || typeof window === 'undefined') {
    return
  }
  const ledger = window.api?.sessionLedger
  if (!ledger) {
    return
  }
  const paneKey = key.slice('pane:'.length)
  void ledger
    .localSessions()
    .then((rows) => {
      const row = rows.find((entry) => entry.paneId === paneKey)
      return row ? ledger.setWaiting(row.ledgerId, waiting) : undefined
    })
    .catch(() => {})
}

export function createWaitLaterStore(
  storage: WaitLaterStorage,
  now: () => Date = () => new Date()
) {
  return create<WaitLaterState>((set, get) => {
    const apply = (view: WaitLater): boolean => {
      const pruned = pruneWaitLater(view, now())
      // Why: a storage failure must not undo the on-screen change; the view is a convenience, not data.
      let saved = true
      try {
        storage.save(pruned)
      } catch {
        saved = false
      }
      set({
        view: pruned,
        waiting: waitingKeys(pruned, now()),
        finished: finishedMarks(pruned),
        returned: returnedMarks(pruned)
      })
      return saved
    }
    return {
      view: emptyWaitLater(),
      loaded: false,
      waiting: EMPTY_KEYS,
      finished: EMPTY_MARKS,
      returned: EMPTY_MARKS,
      load: () => {
        let view: WaitLater
        try {
          const saved = storage.load()
          // Attention deadlines were retired; a session snooze (`conversation:` key) is kept.
          const snoozes = Object.fromEntries(
            Object.entries(saved.until).filter(([key]) => key.startsWith(SESSION_SNOOZE_PREFIX))
          )
          view = pruneWaitLater({ ...saved, until: snoozes }, now())
          if (Object.keys(saved.until).length > Object.keys(snoozes).length) {
            try {
              storage.save(view)
            } catch {
              // The next load safely retries this presentation-only migration.
            }
          }
        } catch {
          view = emptyWaitLater()
        }
        set({
          view,
          loaded: true,
          waiting: waitingKeys(view, now()),
          finished: finishedMarks(view),
          returned: returnedMarks(view)
        })
      },
      tick: () => {
        const next = waitingKeys(get().view, now())
        const current = get().waiting
        if (next.size !== current.size || [...next].some((key) => !current.has(key))) {
          apply(get().view)
          // Why: a wait that passed is the mark being removed; the ledger row stops waiting.
          for (const key of current) {
            if (!next.has(key)) {
              tellSessionLedger(key, false)
            }
          }
        }
      },
      setUntil: (key, until) => {
        const saved = apply(setWaitLater(get().view, key, until))
        tellSessionLedger(key, until !== null)
        return saved
      },
      setFinished: (key, at) => {
        apply(setFinished(get().view, key, at))
      },
      setReturned: (key, at) => {
        apply(setReturned(get().view, key, at))
      }
    }
  })
}

export const useWaitLater = createWaitLaterStore(createLocalWaitLaterStorage())

/** The keys waiting right now; the app root loads the store and re-checks the clock every minute. */
export function useWaitingKeys(): ReadonlySet<string> {
  return useWaitLater((state) => state.waiting)
}

export function useFinishedMarks(): ReadonlyMap<string, number> {
  return useWaitLater((state) => state.finished)
}

/** Panes a plan handed back to the person, for the rows that must say so. */
export function useReturnedMarks(): ReadonlyMap<string, number> {
  return useWaitLater((state) => state.returned)
}

let stopTicker: (() => void) | null = null

export function startWaitLaterTicker(intervalMs = 60_000): () => void {
  stopTicker?.()
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    const now = Date.now()
    const next = Math.min(
      ...Object.values(useWaitLater.getState().view.until)
        .map(Date.parse)
        .filter((at) => at > now)
    )
    deadlineTimer = Number.isFinite(next)
      ? setTimeout(
          () => {
            useWaitLater.getState().tick()
            arm()
          },
          Math.min(2_147_483_647, Math.max(1, next - now))
        )
      : null
  }
  const interval = setInterval(() => useWaitLater.getState().tick(), intervalMs)
  const unsubscribe = useWaitLater.subscribe(arm)
  arm()
  const stop = (): void => {
    clearInterval(interval)
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    unsubscribe()
    if (stopTicker === stop) {
      stopTicker = null
    }
  }
  stopTicker = stop
  return stop
}

/** App root: load the waits once and re-check the clock every minute while the app runs. */
export function useWaitLaterTicker(): void {
  useEffect(() => {
    if (!useWaitLater.getState().loaded) {
      useWaitLater.getState().load()
    }
    return startWaitLaterTicker()
  }, [])
}

const EMPTY_UNTIL: Readonly<Record<string, string>> = Object.freeze({})

/** Return time (ISO) per waiting key, for rows that say when something comes back. */
export function useWaitingUntil(): Readonly<Record<string, string>> {
  const until = useWaitLater((state) => state.view.until)
  const waiting = useWaitLater((state) => state.waiting)
  return waiting.size === 0 ? EMPTY_UNTIL : until
}
