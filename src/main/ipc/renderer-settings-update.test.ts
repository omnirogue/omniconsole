import { describe, expect, it } from 'vitest'
import { sanitizeRendererSettingsUpdate } from './renderer-settings-update'

const CONFIG = {
  protectedWorkspacePaths: ['/work/email/'],
  protectedPaneKeys: [],
  protectStartedToday: true,
  timeZone: 'UTC'
}

describe('renderer settings update protection', () => {
  it('normalizes valid owner-local protection and preserves an explicit disable', () => {
    expect(sanitizeRendererSettingsUpdate({ automaticSessionCleanupProtection: CONFIG })).toEqual({
      automaticSessionCleanupProtection: { ...CONFIG, protectedWorkspacePaths: ['/work/email'] }
    })
    expect(sanitizeRendererSettingsUpdate({ automaticSessionCleanupProtection: null })).toEqual({
      automaticSessionCleanupProtection: null
    })
  })

  it('turns malformed protection into a fail-closed configuration', () => {
    expect(
      sanitizeRendererSettingsUpdate({
        automaticSessionCleanupProtection: { ...CONFIG, timeZone: 'bad-zone' }
      })
    ).toEqual({ automaticSessionCleanupProtection: null })
  })

  it('retains the existing main-owned and obsolete-setting boundaries', () => {
    expect(
      sanitizeRendererSettingsUpdate({
        terminalScrollbackBytes: 123,
        pluginConsents: {},
        disabledPlugins: [],
        archiveSleepsIdleAgents: 'yes',
        autoContinueInterruptedSessions: 'yes',
        idleAutoCloseMode: 'shadow'
      } as never)
    ).toEqual({ idleAutoCloseMode: 'shadow' })
  })

  it('keeps the review wait a whole number of minutes in range', () => {
    expect(sanitizeRendererSettingsUpdate({ reviewWaitLiveMinutes: 720 })).toEqual({
      reviewWaitLiveMinutes: 720
    })
    expect(sanitizeRendererSettingsUpdate({ reviewWaitLiveMinutes: 'soon' } as never)).toEqual({
      reviewWaitLiveMinutes: 60
    })
    expect(sanitizeRendererSettingsUpdate({ reviewWaitLiveMinutes: 0 })).toEqual({
      reviewWaitLiveMinutes: 1
    })
  })
})
