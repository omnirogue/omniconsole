import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  DEFAULT_IDLE_AUTO_CLOSE_MINUTES,
  getEffectiveIdleAutoCloseMinutes,
  getEffectiveIdleAutoCloseMode,
  getEffectiveIdleAutoCloseMs,
  hasOpenAskText,
  keepReasonFromReading,
  MAX_IDLE_AUTO_CLOSE_MINUTES,
  MIN_IDLE_AUTO_CLOSE_MINUTES,
  resolveIdleAutoCloseGate,
  type IdleKeepReading
} from './idle-auto-close-settings'

describe('idle auto-close settings', () => {
  it('defaults to shadow with Sal’s 30-minute window', () => {
    const settings = getDefaultSettings('/tmp')
    expect(settings.idleAutoCloseMode).toBe('shadow')
    expect(settings.idleAutoCloseMinutes).toBe(30)
    expect(DEFAULT_IDLE_AUTO_CLOSE_MINUTES).toBe(30)
  })

  it('reads an unknown or missing mode as shadow, which never acts', () => {
    expect(getEffectiveIdleAutoCloseMode(undefined)).toBe('shadow')
    expect(getEffectiveIdleAutoCloseMode('bogus')).toBe('shadow')
    expect(getEffectiveIdleAutoCloseMode('on')).toBe('on')
    expect(getEffectiveIdleAutoCloseMode('off')).toBe('off')
  })

  it('clamps the window to 5..1440 minutes and falls back on junk', () => {
    expect(getEffectiveIdleAutoCloseMinutes(1)).toBe(MIN_IDLE_AUTO_CLOSE_MINUTES)
    expect(getEffectiveIdleAutoCloseMinutes(99_999)).toBe(MAX_IDLE_AUTO_CLOSE_MINUTES)
    expect(getEffectiveIdleAutoCloseMinutes(Number.NaN)).toBe(30)
    expect(getEffectiveIdleAutoCloseMinutes('45')).toBe(30)
    expect(getEffectiveIdleAutoCloseMs(45)).toBe(45 * 60_000)
  })
})

describe('resolveIdleAutoCloseGate', () => {
  it('shadow logs only; off is the kill switch', () => {
    expect(resolveIdleAutoCloseGate({})).toEqual({ mode: 'shadow', act: false })
    expect(resolveIdleAutoCloseGate({ idleAutoCloseMode: 'off' })).toEqual({
      mode: 'off',
      act: false
    })
  })

  it('refuses to act in `on` unless the restore flood guard is explicitly on', () => {
    for (const restoreFloodGuard of [undefined, false, 'true', 1]) {
      expect(
        resolveIdleAutoCloseGate({ idleAutoCloseMode: 'on', restoreFloodGuard } as never)
      ).toEqual({ mode: 'shadow', act: false, refused: 'restore-flood-guard-off' })
    }
    expect(
      resolveIdleAutoCloseGate({ idleAutoCloseMode: 'on', restoreFloodGuard: true } as never)
    ).toEqual({ mode: 'on', act: true })
  })
})

describe('G1 open-ask text', () => {
  it('keeps a reply that ends with a question, through markdown closers', () => {
    expect(hasOpenAskText('Shall I merge it?')).toBe(true)
    expect(hasOpenAskText('Shall I merge it?**\n')).toBe(true)
    expect(hasOpenAskText('Merged. Nothing left.')).toBe(false)
    expect(hasOpenAskText(undefined)).toBe(false)
  })

  it('keeps a numbered question list of two or more lines', () => {
    expect(hasOpenAskText('Three things:\n1. Phase 0\n2. Auto-close window\n3. Archive')).toBe(true)
    expect(hasOpenAskText('Done:\n  1. merged')).toBe(false)
  })
})

describe('keepReasonFromReading', () => {
  const quiet: IdleKeepReading = {
    paneKey: 'p',
    listed: true,
    state: 'idle',
    openAsk: false,
    keepGoing: false,
    agentForeground: true
  }

  it('lets an idle, quiet reading through and fails closed on none', () => {
    expect(keepReasonFromReading(quiet)).toBeNull()
    expect(keepReasonFromReading({ ...quiet, state: 'unknown' })).toBeNull()
    expect(keepReasonFromReading(undefined)).toBe('unreadable')
    expect(keepReasonFromReading({ ...quiet, failed: true })).toBe('unreadable')
  })

  it('keeps a pane whose own plan still waits on an event', () => {
    expect(keepReasonFromReading({ ...quiet, waitingOn: 'Iris replies on OMR-93' })).toBe(
      'pending-wait'
    )
  })

  it('keeps awaiting-user, waiting-for-yes or an asking reply (G1)', () => {
    expect(keepReasonFromReading({ ...quiet, state: 'awaiting-user' })).toBe('open-ask')
    expect(keepReasonFromReading({ ...quiet, state: 'waiting-for-yes' })).toBe('open-ask')
    expect(keepReasonFromReading({ ...quiet, openAsk: true })).toBe('open-ask')
  })

  it('keeps a busy or kept-going session', () => {
    expect(keepReasonFromReading({ ...quiet, state: 'working' })).toBe('not-idle')
    expect(keepReasonFromReading({ ...quiet, state: 'queued' })).toBe('not-idle')
    expect(keepReasonFromReading({ ...quiet, keepGoing: true })).toBe('not-idle')
  })
})
