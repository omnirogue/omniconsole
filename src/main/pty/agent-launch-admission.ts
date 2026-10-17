import type { GlobalSettings } from '../../shared/global-settings-types'

// Why: a restore sweep once started 51 agents in one minute and pushed the Mac to load ~17;
// every agent start app-wide now takes a slot in one rolling window (Sal, 2026-09-30: "3 agents
// per 10 seconds"). Excess starts wait in FIFO order within three lanes, served in this order:
//   person     — a pane a person just revealed, or a start they asked for from the phone;
//   explicit   — a start a caller asked for right now (CLI, orchestration workers, runtime RPC);
//   background — restores and resumes nobody is looking at (a restore sweep, auto-continue).
// Every lane still uses a slot, so the cap holds; a person never waits behind a backlog, only for
// the next free slot (< 10 s), and an orchestrator's workers never wait behind a restore sweep.

export type AgentLaunchPriority = 'person' | 'explicit' | 'background'

const LANE_RANK: Record<AgentLaunchPriority, number> = { person: 0, explicit: 1, background: 2 }

export const AGENT_LAUNCH_ADMISSION_WINDOW_MS = 10_000
/** A queued start whose caller gave up (its pane went away) rejects with this. */
export const AGENT_LAUNCH_CANCELLED_ERROR = 'agent_launch_cancelled'
export const DEFAULT_LAUNCH_ADMISSION_PER_10S = 3
const MAX_LAUNCH_ADMISSION_PER_10S = 50
/** Bounds the renderer-supplied pane key a queued start can later be promoted by. */
export const MAX_LAUNCH_ADMISSION_KEY_LENGTH = 512

type TimerHandle = ReturnType<typeof setTimeout>

export type AgentLaunchAdmissionClock = {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
}

export type AgentLaunchAdmissionRequest = {
  priority: AgentLaunchPriority
  /** Re-read at every drain so a settings change applies without a restart. 0 = unlimited. */
  getLimit: () => number
  /** A queued start whose caller gave up is dropped without using a slot. */
  isCancelled?: () => boolean
  /** The pane the start is for, so a person revealing it while it waits can promote it. */
  key?: string
  /** Called once, synchronously, when the start could not be admitted at once and waits. */
  onQueued?: () => void
}

export type AgentLaunchAdmission = {
  /** Resolves true once admitted, false when the request was cancelled while queued. */
  admit: (request: AgentLaunchAdmissionRequest) => Promise<boolean>
  /** Moves a queued background or explicit start into the person lane; false when none is. */
  promote: (key: string) => boolean
  /** Drops every queued start whose caller cancelled since the last drain (no slot used). */
  recheck: () => void
  /** A start for this pane is queued, or was admitted within the current window (its spawn may
   *  still be running), so a caller waiting for that pane's PTY should keep waiting. */
  isPending: (key: string) => boolean
  snapshot: () => { queued: number; admittedInWindow: number }
}

type QueuedLaunch = {
  priority: AgentLaunchPriority
  key?: string
  isCancelled?: () => boolean
  resolve: (admitted: boolean) => void
}

const systemClock: AgentLaunchAdmissionClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle)
}

export function resolveLaunchAdmissionPer10s(
  settings: Pick<GlobalSettings, 'launchAdmissionPer10s'> | null | undefined
): number {
  const value = settings?.launchAdmissionPer10s
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_LAUNCH_ADMISSION_PER_10S
  }
  return Math.min(MAX_LAUNCH_ADMISSION_PER_10S, Math.floor(value))
}

export function normalizeLaunchAdmissionKey(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LAUNCH_ADMISSION_KEY_LENGTH
    ? value
    : undefined
}

/** Inserts behind the last queued start of the same or a higher lane, so each lane stays FIFO. */
function insertIntoLane(queue: QueuedLaunch[], entry: QueuedLaunch): void {
  const rank = LANE_RANK[entry.priority]
  let insertAt = 0
  while (insertAt < queue.length && LANE_RANK[queue[insertAt].priority] <= rank) {
    insertAt += 1
  }
  queue.splice(insertAt, 0, entry)
}

export function createAgentLaunchAdmission(
  options: { clock?: AgentLaunchAdmissionClock; windowMs?: number } = {}
): AgentLaunchAdmission {
  const clock = options.clock ?? systemClock
  const windowMs = options.windowMs ?? AGENT_LAUNCH_ADMISSION_WINDOW_MS
  const admitted: { at: number; key?: string }[] = []
  const queue: QueuedLaunch[] = []
  let getLimit: () => number = () => DEFAULT_LAUNCH_ADMISSION_PER_10S
  let timer: TimerHandle | null = null

  const readLimit = (): number => {
    const limit = getLimit()
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  }

  const drain = (): void => {
    if (timer !== null) {
      clock.clearTimer(timer)
      timer = null
    }
    const now = clock.now()
    while (admitted.length > 0 && admitted[0].at <= now - windowMs) {
      admitted.shift()
    }
    // Why the whole queue, not just its head: a start cancelled deep in a backlog (its pane
    // closed) must leave now, not minutes later when it would have reached the head.
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index]
      if (entry.isCancelled?.()) {
        queue.splice(index, 1)
        entry.resolve(false)
      }
    }
    const limit = readLimit()
    while (queue.length > 0) {
      const head = queue[0]
      if (limit > 0 && admitted.length >= limit) {
        break
      }
      queue.shift()
      if (limit > 0) {
        admitted.push({ at: now, ...(head.key ? { key: head.key } : {}) })
      }
      head.resolve(true)
    }
    if (queue.length > 0 && admitted.length > 0) {
      // Why: the next slot frees exactly when the oldest admission leaves the rolling window.
      timer = clock.setTimer(drain, Math.max(0, admitted[0].at + windowMs - now))
    }
  }

  return {
    admit(request) {
      getLimit = request.getLimit
      return new Promise<boolean>((resolve) => {
        const entry: QueuedLaunch = {
          priority: request.priority,
          ...(request.key ? { key: request.key } : {}),
          ...(request.isCancelled ? { isCancelled: request.isCancelled } : {}),
          resolve
        }
        insertIntoLane(queue, entry)
        drain()
        if (request.onQueued && queue.includes(entry)) {
          try {
            request.onQueued()
          } catch {
            // Why: a caller's waiting hook (an RPC keepalive) must never lose the queued start.
          }
        }
      })
    },
    promote(key) {
      const index = queue.findIndex((entry) => entry.key === key && entry.priority !== 'person')
      if (index === -1) {
        return false
      }
      const [entry] = queue.splice(index, 1)
      entry.priority = 'person'
      insertIntoLane(queue, entry)
      drain()
      return true
    },
    recheck() {
      drain()
    },
    isPending(key) {
      const now = clock.now()
      return (
        queue.some((entry) => entry.key === key) ||
        admitted.some((entry) => entry.key === key && entry.at > now - windowMs)
      )
    },
    snapshot() {
      const now = clock.now()
      return {
        queued: queue.length,
        admittedInWindow: admitted.filter((entry) => entry.at > now - windowMs).length
      }
    }
  }
}

/**
 * The one app-wide window every agent start goes through. Every agent process OmniConsole
 * starts is spawned by one of main's two spawn pipelines — the renderer's `pty:spawn`
 * (buildPtyIpcSpawnOptions) and the runtime controller (spawnPtyFromRuntimeController: CLI,
 * phone, orchestration, runtime RPC) — and both pass gatePtySpawnAgentLaunch before taking the
 * per-worktree spawn mutex. They meet again only at provider.spawn, which runs inside that mutex
 * (a queued agent there would block plain shells for up to a whole backlog), so this window is
 * the single shared admission point.
 */
export const agentLaunchAdmission = createAgentLaunchAdmission()
