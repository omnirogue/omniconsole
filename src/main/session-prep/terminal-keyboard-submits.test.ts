import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimTerminalKeyboardSubmit,
  recordTerminalKeyboardSubmit,
  resetTerminalKeyboardSubmitsForTests
} from './terminal-keyboard-submits'

const PROMPT = 'create sessions for a and b'
const claim = (prompt = PROMPT, now = 2_000, identity?: string, pty = 'pty-1') =>
  claimTerminalKeyboardSubmit(pty, prompt, 60_000, 5_000, identity, now)

describe('terminal keyboard submits', () => {
  beforeEach(resetTerminalKeyboardSubmitsForTests)

  it('claims the last Enter when editing made the typed line different', () => {
    recordTerminalKeyboardSubmit('pty-1', 'create sesions', 1_000)
    const first = claim()
    expect(first).not.toBeNull()
    expect(claim()).toBe(first)
    expect(claim('create sessions for something else')).toBeNull()
  })

  it('uses the same receipt for a matching line and its recent Enter', () => {
    recordTerminalKeyboardSubmit('pty-1', 'create  sessions for\na and b', 1_000)
    const first = claim()
    expect(first).not.toBeNull()
    expect(claim()).toBe(first)
    expect(claim('create sessions for something else')).toBeNull()
  })

  it('does not reuse an expired or future Enter as a fallback', () => {
    recordTerminalKeyboardSubmit('pty-1', 'create sesions', 1_000)
    expect(claim(PROMPT, 7_000)).toBeNull()
    expect(claim(PROMPT, 0)).toBeNull()
  })

  it('refuses exact lines that are too old, future-dated or typed in another pty', () => {
    recordTerminalKeyboardSubmit('pty-1', PROMPT, 1_000)
    expect(claim(PROMPT, 2_000, undefined, 'pty-2')).toBeNull()
    expect(claim(PROMPT, 90_000)).toBeNull()
    expect(claim(PROMPT, 0)).toBeNull()
  })

  it('allows a fresh Enter for the same text, even at the same clock time', () => {
    recordTerminalKeyboardSubmit('pty-1', PROMPT, 1_000)
    const first = claim()
    recordTerminalKeyboardSubmit('pty-1', PROMPT, 1_000)
    expect(claim()).not.toBe(first)
  })

  it('does not consume a newer Enter for a replay carrying the original provider identity', () => {
    recordTerminalKeyboardSubmit('pty-1', PROMPT, 1_000)
    const first = claim(PROMPT, 2_000, 'prompt-1')
    recordTerminalKeyboardSubmit('pty-1', PROMPT, 3_000)
    expect(claim(PROMPT, 4_000, 'prompt-1')).toBe(first)
    const next = claim(PROMPT, 4_000, 'prompt-2')
    expect(next).not.toBeNull()
    expect(next).not.toBe(first)
    expect(claim(PROMPT, 4_000, 'prompt-2')).toBe(next)
  })
})
