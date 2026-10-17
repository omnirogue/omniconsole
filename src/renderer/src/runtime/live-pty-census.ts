// Which PTYs are alive right now, as main's PTY providers report them (`pty.listSessions`: the
// local provider's PTYs and the daemon's sessions, plus each SSH provider's), kept current by
// `pty:spawned`, `pty:exit` and the daemon-inventory invalidation that a management kill raises
// instead of an exit. Why (addendum F16): the window's own pane→PTY maps are not liveness —
// startup reconnect seeds `ptyIdsByTabId` from the saved layout before any daemon answers, so a
// PTY that died with the last run still looks bound until its pane mounts. This is the same
// census `worktree-agent-activation-gate.ts` checks a persisted binding against.

import { subscribeDaemonSessionInventoryInvalidated } from '@/components/status-bar/daemon-session-inventory-invalidation'

export type LivePtyCensusApi = Pick<Window['api']['pty'], 'listSessions' | 'onSpawned' | 'onExit'>

export type LivePtyCensus = {
  /** The PTY ids alive now, or null while unknown (before the first listing, or after one failed). */
  current: () => ReadonlySet<string> | null
  stop: () => void
}

const RETRY_INITIAL_MS = 1_000
const RETRY_MAX_MS = 30_000

/** Lists once, then follows lifecycle events; `onChange` runs whenever the answer changes. */
export function startLivePtyCensus(
  api: LivePtyCensusApi | undefined,
  onChange: () => void
): LivePtyCensus {
  if (!api) {
    return { current: () => null, stop: () => {} }
  }
  let live: ReadonlySet<string> | null = null
  let stopped = false
  let listing = false
  let listAgain = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelay = RETRY_INITIAL_MS
  // Why: an exit or spawn that lands while a listing is in flight may be missing from its answer.
  const racedLiveness = new Map<string, boolean>()
  const show = (next: ReadonlySet<string> | null): void => {
    live = next
    onChange()
  }
  const list = (): void => {
    if (stopped) {
      return
    }
    if (listing) {
      listAgain = true
      return
    }
    listing = true
    racedLiveness.clear()
    void api.listSessions().then(
      (sessions) => {
        listing = false
        if (stopped) {
          return
        }
        const next = new Set(sessions.map((session) => session.id))
        for (const [id, alive] of racedLiveness) {
          if (alive) {
            next.add(id)
          } else {
            next.delete(id)
          }
        }
        retryDelay = RETRY_INITIAL_MS
        show(next)
        if (listAgain) {
          listAgain = false
          list()
        }
      },
      () => {
        listing = false
        listAgain = false
        if (stopped) {
          return
        }
        // Why: a census nobody could read says nothing about which PTYs run; unknown until it can.
        show(null)
        retryTimer = setTimeout(() => {
          retryTimer = null
          list()
        }, retryDelay)
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
      }
    )
  }
  const follow = (id: string, alive: boolean): void => {
    if (listing) {
      racedLiveness.set(id, alive)
    }
    if (live && live.has(id) !== alive) {
      const next = new Set(live)
      if (alive) {
        next.add(id)
      } else {
        next.delete(id)
      }
      show(next)
    }
  }
  const stopSpawned = api.onSpawned(({ id }) => follow(id, true))
  const stopExit = api.onExit(({ id }) => follow(id, false))
  const stopInvalidated = subscribeDaemonSessionInventoryInvalidated(list)
  list()
  return {
    current: () => live,
    stop: () => {
      stopped = true
      stopSpawned()
      stopExit()
      stopInvalidated()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
      }
    }
  }
}
