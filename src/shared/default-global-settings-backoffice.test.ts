import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BACKOFFICE_PRODUCTION_URL,
  resolveBackofficeBaseUrl
} from './backoffice-connection'
import { getDefaultSettings } from './constants'

describe('default global settings — backoffice', () => {
  it('points a brand-new profile at the live console, not loopback', () => {
    const settings = getDefaultSettings('/home/someone')
    expect(settings.backofficeEnv).toBe('production')
    expect(resolveBackofficeBaseUrl(settings)).toEqual({
      configured: true,
      env: 'production',
      baseUrl: DEFAULT_BACKOFFICE_PRODUCTION_URL
    })
  })

  it('keeps the loopback URL ready for whoever switches to local', () => {
    const settings = getDefaultSettings('/home/someone')
    expect(settings.backofficeLocalUrl).toBe('http://127.0.0.1:4477')
    expect(resolveBackofficeBaseUrl({ ...settings, backofficeEnv: 'local' })).toEqual({
      configured: true,
      env: 'local',
      baseUrl: 'http://127.0.0.1:4477'
    })
  })
})
