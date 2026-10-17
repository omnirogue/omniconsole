/**
 * Always-on keystroke latency sampler for the focused terminal pane (latency
 * telemetry, PR 1.0). Two measures per sampled keystroke:
 *
 *   echo  — keydown → first PTY data chunk for that pane (within 500 ms)
 *   paint — keydown → the first animation frame after xterm rendered that data
 *           (once parsed), i.e. roughly when the frame is presented, so renderer,
 *           WebGL and WindowServer/compositor delay show up, not just PTY delay
 *
 * Two clocks per keystroke (load-bearing): both measures START at the OS keystroke
 * time (event.timeStamp), so a renderer that ran the keydown handler late shows that
 * stall in the number. Every pairing window (keydown → xterm input, input → echo)
 * runs on the renderer's handler clock instead, because a stalled renderer runs the
 * keydown, the xterm input and the PTY write back to back once it wakes; windows on
 * the OS clock would drop exactly the stalled keystrokes this exists to measure.
 *
 * One summary per active minute (count, p50, p95, max for both) goes to the
 * existing renderer breadcrumb channel, which main writes to main.trace.ndjson.
 * A minute with no keystrokes writes nothing. Keystrokes that are sampled but get no
 * echo in time count as `unechoed`; echoed ones whose paint never lands inside the
 * paint window count as `unpainted`, so a long WebGL/WindowServer stall is visible
 * as a count even though it has no duration to put in the percentiles.
 *
 * Privacy (load-bearing): this module never receives key contents or terminal
 * bytes — its inputs are a pane key, a timestamp and an xterm event source — so a
 * summary can only ever carry counts and durations.
 *
 * Side-effect freedom: measurement only. One keystroke is in flight at a time
 * (the first key of a burst; later keys cannot be told apart in the output), its
 * xterm listeners exist only while it is in flight, and every path swallows its
 * own errors so the keystroke path can never fail because of telemetry.
 */
import {
  resolveKeydownStart,
  summarizeTerminalInputLatency,
  type TerminalInputLatencySummary
} from './terminal-input-latency-math'

export {
  MAX_EVENT_TIMESTAMP_AGE_MS,
  resolveKeydownStart,
  summarizeTerminalInputLatency,
  type TerminalInputLatencySummary
} from './terminal-input-latency-math'

type Disposable = { dispose: () => void }

/** The xterm event sources the paint measure needs. */
export type LatencyTerminal = {
  onRender: (listener: () => void) => Disposable
  onWriteParsed?: (listener: () => void) => Disposable
}

export type TerminalInputLatencySamplerDeps = {
  now: () => number
  isEnabled: () => boolean
  record: (summary: TerminalInputLatencySummary) => void
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** Next animation frame (requestAnimationFrame). Absent: paint is timed at the render. */
  requestFrame?: (callback: () => void) => void
}

export type TerminalInputLatencySampler = {
  /** A keydown reached a terminal pane's element (capture phase). */
  noteKeydown: (paneKey: string, eventTimeStamp?: number) => void
  /** xterm emitted input for the PTY. Starts a sample only right after a keydown. */
  noteTerminalInput: (paneKey: string, terminal: LatencyTerminal) => void
  /** Live PTY output arrived for a pane. */
  noteOutput: (paneKey: string) => void
  /** Emit the current window now (the per-minute timer calls this). */
  flush: () => void
  dispose: () => void
}

export const TERMINAL_INPUT_LATENCY_INTERVAL_MS = 60_000
/** How long after the keystroke's input is written its echo may take (handler clock). */
export const ECHO_WINDOW_MS = 500
/** How long after the echo arrives its paint may take before it counts as unpainted. */
export const PAINT_WINDOW_MS = 1_000
/** A keydown and the xterm input it produced run in the same event dispatch; 100 ms
 *  (handler clock) also covers keypress/IME input events while excluding unrelated
 *  programmatic writes. */
export const KEYDOWN_TO_INPUT_MS = 100
const MAX_SAMPLES_PER_WINDOW = 2_000

type KeydownCandidate = {
  paneKey: string
  /** When the keydown handler ran (handler clock): pairs the key with its xterm input. */
  handledAt: number
  /** When the OS delivered the key: where echo and paint are measured from. */
  keydownAt: number
}

type PendingSample = {
  paneKey: string
  /** Measurement start: the OS keystroke time. */
  keydownAt: number
  /** When the keystroke's input reached xterm (handler clock): anchors the echo window. */
  inputAt: number
  echoAt: number | null
  parsedAfterEcho: boolean
  rendered: boolean
  hasWriteParsed: boolean
  disposables: Disposable[]
  expiry: unknown
}

function pushBounded(values: number[], value: number): void {
  if (values.length < MAX_SAMPLES_PER_WINDOW && Number.isFinite(value) && value >= 0) {
    values.push(value)
  }
}

export function createTerminalInputLatencySampler(
  deps: TerminalInputLatencySamplerDeps
): TerminalInputLatencySampler {
  let candidate: KeydownCandidate | null = null
  let pending: PendingSample | null = null
  let windowStartedAt: number | null = null
  let keys = 0
  let unechoed = 0
  let unpainted = 0
  let echoMs: number[] = []
  let paintMs: number[] = []
  let timer: unknown = null

  const resetWindow = (now: number | null): void => {
    windowStartedAt = now
    keys = 0
    unechoed = 0
    unpainted = 0
    echoMs = []
    paintMs = []
  }

  const finishPending = (): void => {
    const sample = pending
    if (!sample) {
      return
    }
    pending = null
    deps.clearTimeout(sample.expiry)
    for (const disposable of sample.disposables) {
      try {
        disposable.dispose()
      } catch {
        // A disposed terminal already dropped its listeners.
      }
    }
  }

  /** The in-flight sample ran out of time: no echo, or an echo whose paint never landed. */
  const expirePending = (): void => {
    if (pending) {
      if (pending.echoAt === null) {
        unechoed += 1
      } else {
        unpainted += 1
      }
    }
    finishPending()
  }

  const stopTimer = (): void => {
    if (timer !== null) {
      deps.clearInterval(timer)
      timer = null
    }
  }

  const flush = (): void => {
    try {
      if (!deps.isEnabled()) {
        finishPending()
        resetWindow(null)
        stopTimer()
        return
      }
      if (keys === 0) {
        // Why stop: an idle app should not wake up every minute to report nothing.
        resetWindow(null)
        stopTimer()
        return
      }
      const now = deps.now()
      deps.record(
        summarizeTerminalInputLatency({
          windowMs: now - (windowStartedAt ?? now),
          keys,
          echoMs,
          paintMs,
          unechoed,
          unpainted
        })
      )
      resetWindow(now)
    } catch {
      // Diagnostics only.
    }
  }

  const ensureTimer = (now: number): void => {
    if (windowStartedAt === null) {
      windowStartedAt = now
    }
    if (timer === null) {
      timer = deps.setInterval(flush, TERMINAL_INPUT_LATENCY_INTERVAL_MS)
    }
  }

  const startSample = (
    paneKey: string,
    keydownAt: number,
    inputAt: number,
    terminal: LatencyTerminal
  ): void => {
    const sample: PendingSample = {
      paneKey,
      keydownAt,
      inputAt,
      echoAt: null,
      parsedAfterEcho: false,
      rendered: false,
      hasWriteParsed: typeof terminal.onWriteParsed === 'function',
      disposables: [],
      expiry: null
    }
    pending = sample
    try {
      if (sample.hasWriteParsed) {
        sample.disposables.push(
          terminal.onWriteParsed!(() => {
            if (pending === sample && sample.echoAt !== null) {
              sample.parsedAfterEcho = true
            }
          })
        )
      }
      sample.disposables.push(
        terminal.onRender(() => {
          if (pending !== sample || sample.echoAt === null || sample.rendered) {
            return
          }
          // Why wait for a parse: a render already queued (cursor blink, earlier
          // output) can land between the echo's arrival and its parse.
          if (sample.hasWriteParsed && !sample.parsedAfterEcho) {
            return
          }
          sample.rendered = true
          const recordPaint = (): void => {
            if (pending !== sample || sample.echoAt === null) {
              return
            }
            const now = deps.now()
            if (now - sample.echoAt > PAINT_WINDOW_MS) {
              // Why count it: a paint this late (a GPU/compositor stall) is the delay
              // this measure exists to show; dropping it silently would hide it.
              expirePending()
              return
            }
            pushBounded(paintMs, now - sample.keydownAt)
            finishPending()
          }
          // Why the next frame: xterm draws inside a frame callback; the frame that
          // carries the echo is presented around the start of the following one.
          if (deps.requestFrame) {
            deps.requestFrame(recordPaint)
          } else {
            recordPaint()
          }
        })
      )
    } catch {
      // Why drop the sample: without a render source there is no paint to measure,
      // and a half-subscribed sample must not linger.
      finishPending()
      return
    }
    sample.expiry = deps.setTimeout(() => {
      if (pending === sample) {
        expirePending()
      }
    }, ECHO_WINDOW_MS + PAINT_WINDOW_MS)
  }

  return {
    noteKeydown(paneKey, eventTimeStamp) {
      try {
        if (!deps.isEnabled()) {
          return
        }
        const now = deps.now()
        candidate = { paneKey, handledAt: now, keydownAt: resolveKeydownStart(eventTimeStamp, now) }
      } catch {
        candidate = null
      }
    },

    noteTerminalInput(paneKey, terminal) {
      try {
        const keydown = candidate
        if (!keydown || keydown.paneKey !== paneKey) {
          return
        }
        const now = deps.now()
        candidate = null
        // Why the handler clock: a late renderer runs keydown and its input back to back,
        // so this gap stays small however late the dispatch ran.
        if (now - keydown.handledAt > KEYDOWN_TO_INPUT_MS) {
          return
        }
        ensureTimer(now)
        keys += 1
        if (pending) {
          const stale =
            pending.echoAt === null
              ? now - pending.inputAt > ECHO_WINDOW_MS
              : now - pending.echoAt > PAINT_WINDOW_MS
          if (!stale) {
            return
          }
          expirePending()
        }
        startSample(paneKey, keydown.keydownAt, now, terminal)
      } catch {
        // Diagnostics only.
      }
    },

    noteOutput(paneKey) {
      const sample = pending
      if (!sample || sample.paneKey !== paneKey || sample.echoAt !== null) {
        return
      }
      try {
        const now = deps.now()
        // Why the input time: the window pairs this output with the input just written
        // to the PTY; the reported duration still starts at the OS keystroke time.
        if (now - sample.inputAt > ECHO_WINDOW_MS) {
          expirePending()
          return
        }
        pushBounded(echoMs, now - sample.keydownAt)
        sample.echoAt = now
      } catch {
        // Diagnostics only.
      }
    },

    flush,

    dispose() {
      finishPending()
      stopTimer()
      resetWindow(null)
      candidate = null
    }
  }
}
