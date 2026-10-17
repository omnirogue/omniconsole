import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  getDefaultSessionStewardSettings,
  normalizeSessionStewardSettings,
  SESSION_STEWARD_SWITCHES,
  sessionStewardDisabledByEnv,
  sessionStewardMode
} from './session-steward-settings'
import {
  getDefaultStewardOrganizeSettings,
  stewardOrganizeModeOf
} from './session-steward-organize-settings'

describe('session steward settings', () => {
  it('ships every switch on (Sal, 25 Sep), shadow never the default', () => {
    expect(getDefaultSettings('/home/me').sessionSteward).toEqual({
      enabled: true,
      safeYes: 'on',
      nudges: true,
      tier2Archive: 'on',
      automaticCleanup: true,
      sessionWaits: true,
      tier1WaiterCheck: true,
      emptySessionArchive: true,
      emptySessionAction: 'close',
      emptySessionCloseMinutes: 2,
      pileupThreshold: 8,
      organize: {
        refile: 'on',
        retitle: 'on',
        mergeSuggestions: true,
        projectSuggestions: true,
        accuracyGuard: { windowDays: 14, minSamples: 5, maxCorrectionRate: 0.2 },
        pairReadsPerDay: 50
      }
    })
    for (const feature of SESSION_STEWARD_SWITCHES) {
      expect(sessionStewardMode(getDefaultSessionStewardSettings(), feature, false)).toBe('on')
    }
  })

  it('reads a missing, broken or partial setting as on, and only an explicit off as off', () => {
    expect(normalizeSessionStewardSettings(undefined)).toEqual(getDefaultSessionStewardSettings())
    expect(normalizeSessionStewardSettings('yes')).toEqual(getDefaultSessionStewardSettings())
    expect(
      normalizeSessionStewardSettings({
        nudges: false,
        safeYes: 'shadow',
        tier2Archive: false,
        sessionWaits: 0,
        pileupThreshold: 0
      })
    ).toEqual({
      ...getDefaultSessionStewardSettings(),
      nudges: false,
      safeYes: 'shadow',
      tier2Archive: 'off',
      pileupThreshold: 8
    })
    expect(normalizeSessionStewardSettings({ safeYes: 'sometimes' }).safeYes).toBe('on')
    expect(normalizeSessionStewardSettings({ pileupThreshold: 12 }).pileupThreshold).toBe(12)
  })

  it('closes blank sessions after 2 min, 1 to 1440, and drops the old 30-minute key', () => {
    // Why: the old key's 30 was its first default (Sal, 27 Sep), so a stored one is not kept.
    expect(normalizeSessionStewardSettings({ emptySessionMinutes: 30 })).toMatchObject({
      emptySessionAction: 'close',
      emptySessionCloseMinutes: 2
    })
    expect(normalizeSessionStewardSettings({ emptySessionMinutes: 30 })).not.toHaveProperty(
      'emptySessionMinutes'
    )
    const minutes = (value: unknown) =>
      normalizeSessionStewardSettings({ emptySessionCloseMinutes: value }).emptySessionCloseMinutes
    expect([1, 5, 1440].map(minutes)).toEqual([1, 5, 1440])
    expect([0, 1441, 2.5, '5', null].map(minutes)).toEqual([2, 2, 2, 2, 2])
    const action = (value: unknown) =>
      normalizeSessionStewardSettings({ emptySessionAction: value }).emptySessionAction
    expect([action('archive'), action('close'), action('delete'), action(undefined)]).toEqual([
      'archive',
      'close',
      'close',
      'close'
    ])
  })

  it('lets `enabled` off and the env stop turn every switch off', () => {
    const off = { ...getDefaultSessionStewardSettings(), enabled: false }
    for (const feature of SESSION_STEWARD_SWITCHES) {
      expect(sessionStewardMode(off, feature, false)).toBe('off')
      expect(sessionStewardMode(getDefaultSessionStewardSettings(), feature, true)).toBe('off')
    }
    const shadow = { ...getDefaultSessionStewardSettings(), tier2Archive: 'shadow' as const }
    expect(sessionStewardMode(shadow, 'tier2Archive', false)).toBe('shadow')
  })

  it('reads OMNI_STEWARD_DISABLED like JEV_DECISIONS_DISABLED', () => {
    expect(sessionStewardDisabledByEnv({ OMNI_STEWARD_DISABLED: '1' })).toBe(true)
    expect(sessionStewardDisabledByEnv({ OMNI_STEWARD_DISABLED: 'true' })).toBe(true)
    expect(sessionStewardDisabledByEnv({ OMNI_STEWARD_DISABLED: '0' })).toBe(false)
    expect(sessionStewardDisabledByEnv({ OMNI_STEWARD_DISABLED: 'false' })).toBe(false)
    expect(sessionStewardDisabledByEnv({ OMNI_STEWARD_DISABLED: ' ' })).toBe(false)
    expect(sessionStewardDisabledByEnv({})).toBe(false)
  })

  it('ships Phase 3 organizing on, reads paused, and off under every stop (incl. the JEV stop)', () => {
    const organize = normalizeSessionStewardSettings({
      organize: {
        refile: 'paused',
        retitle: false,
        mergeSuggestions: false,
        accuracyGuard: { windowDays: 0, minSamples: 8, maxCorrectionRate: 2 },
        pairReadsPerDay: 'lots'
      }
    }).organize
    expect(organize).toEqual({
      refile: 'paused',
      retitle: 'off',
      mergeSuggestions: false,
      projectSuggestions: true,
      accuracyGuard: { windowDays: 14, minSamples: 8, maxCorrectionRate: 0.2 },
      pairReadsPerDay: 50
    })
    expect(normalizeSessionStewardSettings({ organize: 'on' }).organize).toEqual(
      getDefaultStewardOrganizeSettings()
    )
    const defaults = getDefaultStewardOrganizeSettings()
    for (const feature of [
      'refile',
      'retitle',
      'mergeSuggestions',
      'projectSuggestions'
    ] as const) {
      expect(stewardOrganizeModeOf(defaults, feature, false)).toBe('on')
      expect(stewardOrganizeModeOf(defaults, feature, true)).toBe('off')
    }
    expect(stewardOrganizeModeOf(organize, 'refile', false)).toBe('paused')
    expect(stewardOrganizeModeOf(organize, 'mergeSuggestions', false)).toBe('off')
  })
})
