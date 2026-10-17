import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BACKOFFICE_LOCAL_URL,
  DEFAULT_BACKOFFICE_PRODUCTION_URL,
  normalizeBackofficeEnv,
  resolveBackofficeBaseUrl
} from './backoffice-connection'

describe('normalizeBackofficeEnv', () => {
  it('defaults a profile that never chose an environment to production', () => {
    expect(normalizeBackofficeEnv(undefined)).toBe('production')
    expect(normalizeBackofficeEnv(null)).toBe('production')
    expect(normalizeBackofficeEnv('nonsense')).toBe('production')
  })

  it('keeps an explicitly chosen environment', () => {
    expect(normalizeBackofficeEnv('local')).toBe('local')
    expect(normalizeBackofficeEnv('production')).toBe('production')
  })
})

describe('resolveBackofficeBaseUrl', () => {
  it('sends a fresh profile to the live console instead of loopback', () => {
    expect(resolveBackofficeBaseUrl({})).toEqual({
      configured: true,
      env: 'production',
      baseUrl: DEFAULT_BACKOFFICE_PRODUCTION_URL
    })
  })

  it('keeps a profile that explicitly chose local on the loopback backoffice', () => {
    expect(resolveBackofficeBaseUrl({ backofficeEnv: 'local' })).toEqual({
      configured: true,
      env: 'local',
      baseUrl: DEFAULT_BACKOFFICE_LOCAL_URL
    })
    expect(
      resolveBackofficeBaseUrl({
        backofficeEnv: 'local',
        backofficeLocalUrl: 'http://localhost:9000'
      })
    ).toEqual({ configured: true, env: 'local', baseUrl: 'http://localhost:9000' })
  })

  it('honours a configured production URL over the default', () => {
    expect(
      resolveBackofficeBaseUrl({
        backofficeEnv: 'production',
        backofficeProductionUrl: 'https://console.example.com/'
      })
    ).toEqual({
      configured: true,
      env: 'production',
      baseUrl: 'https://console.example.com'
    })
  })

  it('falls back to the default when the stored production URL is blank', () => {
    expect(
      resolveBackofficeBaseUrl({ backofficeEnv: 'production', backofficeProductionUrl: '   ' })
    ).toEqual({
      configured: true,
      env: 'production',
      baseUrl: DEFAULT_BACKOFFICE_PRODUCTION_URL
    })
  })

  it('still refuses a plain-http production URL rather than substituting the default', () => {
    const resolved = resolveBackofficeBaseUrl({
      backofficeEnv: 'production',
      backofficeProductionUrl: 'http://console.example.com'
    })
    expect(resolved.configured).toBe(false)
    expect(resolved).not.toHaveProperty('baseUrl')
  })

  it('reports an emptied local URL as unconfigured', () => {
    const resolved = resolveBackofficeBaseUrl({ backofficeEnv: 'local', backofficeLocalUrl: '' })
    expect(resolved).toEqual({
      configured: false,
      env: 'local',
      message: 'Enter a backoffice URL.'
    })
  })
})
