import { describe, expect, it } from 'vitest'
import {
  judgeTerminalQuietWindow,
  QUIET_WINDOW_STARVATION_FACTOR
} from './terminal-parse-quiet-window-verdict'

describe('judgeTerminalQuietWindow', () => {
  it('condemns the parser only for an on-time window in a visible window', () => {
    expect(
      judgeTerminalQuietWindow({ armedAtMs: 0, nowMs: 1_000, windowMs: 1_000, windowVisible: true })
    ).toBe('wedged')
  })

  it('never condemns while the window is hidden, whatever the clock says', () => {
    expect(
      judgeTerminalQuietWindow({
        armedAtMs: 0,
        nowMs: 1_000,
        windowMs: 1_000,
        windowVisible: false
      })
    ).toBe('window-hidden')
  })

  it('treats a deadline that fired far too late as timer starvation, not silence', () => {
    const late = 1_000 * QUIET_WINDOW_STARVATION_FACTOR + 1
    expect(
      judgeTerminalQuietWindow({ armedAtMs: 0, nowMs: late, windowMs: 1_000, windowVisible: true })
    ).toBe('timer-starved')
    expect(
      judgeTerminalQuietWindow({
        armedAtMs: 0,
        nowMs: late - 1,
        windowMs: 1_000,
        windowVisible: true
      })
    ).toBe('wedged')
  })
})
