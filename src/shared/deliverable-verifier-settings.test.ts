import { describe, expect, it } from 'vitest'
import {
  DELIVERABLE_VERIFIER_DISABLED_ENV,
  getDefaultDeliverableVerifierSettings,
  normalizeDeliverableVerifierSettings
} from './deliverable-verifier-settings'

describe('normalizeDeliverableVerifierSettings', () => {
  it('reads a missing setting as Watch only with 2 repairs', () => {
    expect(normalizeDeliverableVerifierSettings(undefined)).toEqual({
      mode: 'shadow',
      maxRepairs: 2
    })
    expect(getDefaultDeliverableVerifierSettings()).toEqual({ mode: 'shadow', maxRepairs: 2 })
  })

  it('keeps a valid setting', () => {
    expect(normalizeDeliverableVerifierSettings({ mode: 'on', maxRepairs: 3 })).toEqual({
      mode: 'on',
      maxRepairs: 3
    })
    expect(normalizeDeliverableVerifierSettings({ mode: 'on' })).toEqual({
      mode: 'on',
      maxRepairs: 2
    })
  })

  it('reads anything malformed as off', () => {
    for (const raw of [
      'on',
      [],
      { mode: 'always' },
      { mode: 'on', maxRepairs: 4 },
      { mode: 'on', maxRepairs: 1.5 }
    ]) {
      expect(normalizeDeliverableVerifierSettings(raw).mode).toBe('off')
    }
  })

  it('honours the environment kill switch', () => {
    expect(
      normalizeDeliverableVerifierSettings(
        { mode: 'on', maxRepairs: 2 },
        {
          [DELIVERABLE_VERIFIER_DISABLED_ENV]: '1'
        }
      ).mode
    ).toBe('off')
  })
})
