import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advanceCodexResumeRelaunch,
  attachCodexResumeRelaunchCapture,
  beginCodexResumeRelaunch,
  clearCodexResumeRelaunch,
  CODEX_RELAUNCH_STALE_IN_FLIGHT_MS,
  isCodexResumeRelaunchInFlight,
  readCodexResumeRelaunch,
  readCodexResumeRelaunchCapture,
  resetCodexResumeRelaunchForTests,
  subscribeCodexResumeRelaunch,
  type CodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'

const PANE = 'tab-1:leaf-1'

function status(phase: CodexResumeRelaunchStatus['phase']): CodexResumeRelaunchStatus {
  return {
    phase,
    requested: { model: 'gpt-5.5', effort: 'high' },
    selectedOption: 'effort',
    threadId: 'thread-1',
    previousPtyId: 'pty-1',
    startedAt: 1000
  }
}

describe('codex resume relaunch state', () => {
  beforeEach(() => resetCodexResumeRelaunchForTests())
  afterEach(() => {
    resetCodexResumeRelaunchForTests()
    vi.useRealTimers()
  })

  it('releases delivery interest at the stale deadline without a mounted verifier', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    beginCodexResumeRelaunch(PANE, status('verifying'))
    const capture = { ptyId: 'pty-2', text: () => 'startup', dispose: vi.fn() }
    vi.advanceTimersByTime(5000)
    attachCodexResumeRelaunchCapture(PANE, capture)
    vi.advanceTimersByTime(CODEX_RELAUNCH_STALE_IN_FLIGHT_MS - 5001)
    expect(readCodexResumeRelaunchCapture(PANE)).toBe(capture)
    vi.advanceTimersByTime(1)
    expect(capture.dispose).toHaveBeenCalledOnce()
    expect(readCodexResumeRelaunchCapture(PANE)).toBeNull()
  })

  it('cancels an old expiry when a new attempt replaces the capture', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    beginCodexResumeRelaunch(PANE, status('verifying'))
    const first = { ptyId: 'pty-2', text: () => '', dispose: vi.fn() }
    attachCodexResumeRelaunchCapture(PANE, first)
    vi.advanceTimersByTime(10000)
    beginCodexResumeRelaunch(PANE, { ...status('verifying'), startedAt: Date.now() })
    const second = { ptyId: 'pty-3', text: () => '', dispose: vi.fn() }
    attachCodexResumeRelaunchCapture(PANE, second)
    vi.advanceTimersByTime(CODEX_RELAUNCH_STALE_IN_FLIGHT_MS - 10000)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).not.toHaveBeenCalled()
    advanceCodexResumeRelaunch(PANE, { phase: 'confirmed' })
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('begin, advance and clear notify subscribers', () => {
    const listener = vi.fn()
    subscribeCodexResumeRelaunch(listener)
    beginCodexResumeRelaunch(PANE, status('restarting'))
    expect(listener).toHaveBeenCalledTimes(1)
    advanceCodexResumeRelaunch(PANE, { phase: 'verifying', newPtyId: 'pty-2' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(readCodexResumeRelaunch(PANE)).toMatchObject({ phase: 'verifying', newPtyId: 'pty-2' })
    clearCodexResumeRelaunch(PANE)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(readCodexResumeRelaunch(PANE)).toBeNull()
  })

  it('reports in flight only while restarting or verifying', () => {
    expect(isCodexResumeRelaunchInFlight(PANE)).toBe(false)
    for (const phase of ['restarting', 'verifying'] as const) {
      beginCodexResumeRelaunch(PANE, status(phase))
      expect(isCodexResumeRelaunchInFlight(PANE)).toBe(true)
    }
    for (const phase of ['confirmed', 'mismatch', 'unverified', 'failed'] as const) {
      beginCodexResumeRelaunch(PANE, status(phase))
      expect(isCodexResumeRelaunchInFlight(PANE)).toBe(false)
    }
  })

  it('ignores an advance for an unknown pane', () => {
    const listener = vi.fn()
    subscribeCodexResumeRelaunch(listener)
    advanceCodexResumeRelaunch('nope', { phase: 'failed' })
    expect(listener).not.toHaveBeenCalled()
    expect(readCodexResumeRelaunch('nope')).toBeNull()
  })

  it('keeps a terminal phase until the next begin', () => {
    beginCodexResumeRelaunch(PANE, status('verifying'))
    advanceCodexResumeRelaunch(PANE, {
      phase: 'confirmed',
      observed: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(readCodexResumeRelaunch(PANE)).toMatchObject({
      phase: 'confirmed',
      observed: { model: 'gpt-5.5', effort: 'high' }
    })
    beginCodexResumeRelaunch(PANE, status('restarting'))
    expect(readCodexResumeRelaunch(PANE)?.observed).toBeUndefined()
    expect(readCodexResumeRelaunch(PANE)?.phase).toBe('restarting')
  })
})
