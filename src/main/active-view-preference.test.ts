import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActiveViewPreference,
  getActiveViewPreferenceFile,
  resolveLaunchActiveView
} from './active-view-preference'

describe('ActiveViewPreference', () => {
  let dir: string
  let dataFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-active-view-'))
    dataFile = join(dir, 'omni-data.json')
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('migrates the legacy durable-state value into the profile sidecar', async () => {
    // Why: this exercises the sidecar migration; restoring is the e2e/restart posture.
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'tasks', { restoreLastView: true })

    expect(preference.get()).toBe('tasks')
    expect(existsSync(getActiveViewPreferenceFile(dataFile))).toBe(false)

    // The renderer reasserts its hydrated value once persistence is ready.
    expect(preference.set('tasks')).toBe(false)
    vi.advanceTimersByTime(100)
    await preference.waitForPendingWrite()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'tasks'
    })
  })

  it('coalesces rapid switches into one tiny preference write', async () => {
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'terminal')

    preference.set('settings')
    vi.advanceTimersByTime(50)
    preference.set('automations')
    vi.advanceTimersByTime(50)
    expect(existsSync(getActiveViewPreferenceFile(dataFile))).toBe(false)

    vi.advanceTimersByTime(50)
    await preference.waitForPendingWrite()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'automations'
    })
  })

  it('flushes synchronously for an immediate graceful exit', () => {
    vi.useFakeTimers()
    const preference = new ActiveViewPreference(dataFile, 'terminal')

    preference.set('settings')
    preference.flushOrThrow()

    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'settings'
    })
    vi.advanceTimersByTime(100)
    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'settings'
    })
  })

  it('boots on Work and can persist the restored Inbox view for in-session navigation', () => {
    vi.useFakeTimers()
    writeFileSync(getActiveViewPreferenceFile(dataFile), '{"activeView":"inbox"}', 'utf-8')
    const preference = new ActiveViewPreference(dataFile, 'inbox')

    expect(preference.get()).toBe('work')
    expect(preference.set('inbox')).toBe(true)
    expect(preference.get()).toBe('inbox')
    preference.flushOrThrow()
    expect(JSON.parse(readFileSync(getActiveViewPreferenceFile(dataFile), 'utf-8'))).toEqual({
      activeView: 'inbox'
    })
    expect(new ActiveViewPreference(dataFile, null, { restoreLastView: true }).get()).toBe('inbox')
  })

  it('ignores an invalid sidecar and invalid updates', () => {
    writeFileSync(getActiveViewPreferenceFile(dataFile), '{"activeView":"unknown"}', 'utf-8')
    const preference = new ActiveViewPreference(dataFile, 'not-a-view', { restoreLastView: false })

    // Why: with nothing valid to restore, a launch lands on Work, the home screen.
    expect(preference.get()).toBe('work')
    expect(preference.set('also-not-a-view')).toBe(false)
    expect(preference.get()).toBe('work')
  })

  it('launches on Work, the home, whatever page was open last', () => {
    const launch = { restoreLastView: false }
    expect(resolveLaunchActiveView(null, null, launch)).toBe('work')
    expect(resolveLaunchActiveView('terminal', null, launch)).toBe('work')
    expect(resolveLaunchActiveView('attention', null, launch)).toBe('work')
    expect(resolveLaunchActiveView('tasks', null, launch)).toBe('work')
    expect(resolveLaunchActiveView(null, 'settings', launch)).toBe('work')
  })

  it('restores the last view when asked to (the e2e posture)', () => {
    // Why: the e2e suites drive the workbench from the landing; their start is unchanged.
    const launch = { restoreLastView: true }
    expect(resolveLaunchActiveView(null, null, launch)).toBe('terminal')
    expect(resolveLaunchActiveView('terminal', null, launch)).toBe('terminal')
    expect(resolveLaunchActiveView('tasks', null, launch)).toBe('tasks')
    expect(resolveLaunchActiveView('calendar', null, launch)).toBe('calendar')
    expect(resolveLaunchActiveView(null, 'calendar', launch)).toBe('calendar')
  })

  it('rejects inherited object keys from a corrupt sidecar', () => {
    // Why: `constructor`/`__proto__` are truthy under `in`; the sidecar must not
    // treat them as a valid view and leave the main surface blank.
    writeFileSync(getActiveViewPreferenceFile(dataFile), '{"activeView":"constructor"}', 'utf-8')
    const preference = new ActiveViewPreference(dataFile, 'tasks', { restoreLastView: true })

    expect(preference.get()).toBe('tasks')
    expect(preference.set('__proto__')).toBe(false)
    expect(preference.get()).toBe('tasks')
  })
})

describe('command center launch gate', () => {
  it('changes only the normal launch default when enabled', () => {
    for (const commandCenter of [false, true]) {
      for (const stored of ['attention', 'grid'] as const) {
        expect(
          resolveLaunchActiveView(stored, null, { restoreLastView: false, commandCenter })
        ).toBe(commandCenter ? 'attention' : 'work')
        expect(
          resolveLaunchActiveView(stored, null, { restoreLastView: true, commandCenter })
        ).toBe(stored)
      }
    }
  })
})
