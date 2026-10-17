// Why this module exists: the wedge guards (replay-guard.ts and
// terminal-write-pipeline-health.ts) certify a terminal's write pipeline dead
// after a probe window passes with no parse progress. That inference assumes
// the renderer was running timers normally. It was not in the field: the
// main window left Chromium's background throttling on, so a hidden or
// occluded window parsed at one timer tick per second, and system sleep
// starved every timer at once. Both showed up as same-second bursts of
// `terminal_replay_guard_wedged_release` across every restoring pane,
// each followed by a needless pane remount. A silent window is only evidence
// when the window was visible and the deadline fired on time.

export type TerminalQuietWindowVerdict = 'wedged' | 'window-hidden' | 'timer-starved'

/** A deadline that fires this much later than armed was starved (sleep, throttling, a blocked main thread). */
export const QUIET_WINDOW_STARVATION_FACTOR = 1.5

export function judgeTerminalQuietWindow(input: {
  armedAtMs: number
  nowMs: number
  windowMs: number
  windowVisible: boolean
}): TerminalQuietWindowVerdict {
  if (!input.windowVisible) {
    return 'window-hidden'
  }
  if (input.nowMs - input.armedAtMs > input.windowMs * QUIET_WINDOW_STARVATION_FACTOR) {
    return 'timer-starved'
  }
  return 'wedged'
}
