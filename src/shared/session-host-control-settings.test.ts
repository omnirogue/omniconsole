import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  normalizeSessionHostControlSettings,
  sessionHostControlDisabledByEnv
} from './session-host-control-settings'

describe('this computer’s execution-host switches', () => {
  it('are all on by default, with no folder overrides', () => {
    expect(getDefaultSettings('/home/me').sessionHostControl).toEqual({
      remoteControls: true,
      hostStewardship: true,
      folderPolicies: {},
      hostPolicies: {},
      relocation: true
    })
    expect(normalizeSessionHostControlSettings(undefined)).toEqual({
      remoteControls: true,
      hostStewardship: true,
      folderPolicies: {},
      hostPolicies: {},
      relocation: true
    })
  })

  it('turn off only when explicitly off', () => {
    expect(
      normalizeSessionHostControlSettings({ remoteControls: false, hostStewardship: 'no' })
    ).toMatchObject({ remoteControls: false, hostStewardship: true })
  })

  it('read a folder override it cannot understand as automation off, never as relaxed', () => {
    expect(
      normalizeSessionHostControlSettings({
        folderPolicies: {
          ops: { automation: 'off' },
          future: { automation: 'off', newRestriction: 'x' },
          broken: { automation: 'on' }
        }
      }).folderPolicies
    ).toEqual({
      ops: { automation: 'off' },
      future: { automation: 'off', newRestriction: 'x', relocation: 'off' },
      broken: { automation: 'off', relocation: 'off' }
    })
  })

  it('stop at once with OMNI_SESSION_HOST_DISABLED', () => {
    expect(sessionHostControlDisabledByEnv({ OMNI_SESSION_HOST_DISABLED: '1' })).toBe(true)
    expect(sessionHostControlDisabledByEnv({ OMNI_SESSION_HOST_DISABLED: '0' })).toBe(false)
    expect(sessionHostControlDisabledByEnv({})).toBe(false)
  })
})
