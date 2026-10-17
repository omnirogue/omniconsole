import { describe, expect, it } from 'vitest'
import {
  decideWebPairingStartup,
  parseWebPairingInput,
  readPairingInputFromLocation,
  type WebPairingOffer
} from './web-pairing'

describe.each(['omni', 'orca'])('%s web pairing input', (scheme) => {
  const offer: WebPairingOffer = {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  }

  function encodeOffer(overrides: Record<string, unknown> = {}) {
    return Buffer.from(JSON.stringify({ ...offer, ...overrides }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }

  it('parses query-form pairing URLs', () => {
    expect(parseWebPairingInput(`${scheme}://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('retains a full pairing link in the browser location hash', () => {
    const pairingUrl = `${scheme}://pair?code=${encodeOffer()}`
    expect(readPairingInputFromLocation({ search: '', hash: `#${pairingUrl}` } as Location)).toBe(
      pairingUrl
    )
  })

  it('still parses legacy hash-form pairing URLs', () => {
    expect(parseWebPairingInput(`${scheme}://pair#${encodeOffer()}`)).toEqual(offer)
  })

  it('preserves optional device scope metadata', () => {
    expect(
      parseWebPairingInput(`${scheme}://pair?code=${encodeOffer({ scope: 'mobile' })}`)
    ).toEqual({
      ...offer,
      scope: 'mobile'
    })
  })

  it('preserves optional paired device identity', () => {
    expect(
      parseWebPairingInput(
        `${scheme}://pair?code=${encodeOffer({ pairedDeviceId: 'paired-device-a' })}`
      )
    ).toEqual({
      ...offer,
      pairedDeviceId: 'paired-device-a'
    })
  })

  it.each([
    ['wss://proxy.example:443/omni/runtime', 'wss://proxy.example:443/omni/runtime'],
    ['https://proxy.example/omni/runtime', 'wss://proxy.example/omni/runtime'],
    ['http://proxy.example:8080/omni/runtime', 'ws://proxy.example:8080/omni/runtime']
  ])('preserves reverse-proxy endpoint routing for %s', (endpoint, expected) => {
    expect(parseWebPairingInput(encodeOffer({ endpoint }))).toMatchObject({ endpoint: expected })
  })

  it('treats invalid device scope metadata as unknown', () => {
    expect(
      parseWebPairingInput(`${scheme}://pair?code=${encodeOffer({ scope: 'admin' })}`)
    ).toEqual(offer)
  })

  it('rejects URLs outside the exact pairing route', () => {
    expect(parseWebPairingInput(`${scheme}://pairing?code=${encodeOffer()}`)).toBeNull()
    expect(parseWebPairingInput(`${scheme}://pair-extra?code=${encodeOffer()}`)).toBeNull()
  })

  it('auto-saves scoped runtime offers during web startup', () => {
    const input = `${scheme}://pair?code=${encodeOffer({ scope: 'runtime' })}`
    expect(
      decideWebPairingStartup({ initialPairingInput: input, hasStoredEnvironment: false })
    ).toEqual({
      kind: 'auto-save-runtime-offer',
      offer: { ...offer, scope: 'runtime' }
    })
  })

  it('shows the connect screen for mobile-scope and legacy unknown-scope offers', () => {
    const mobileInput = `${scheme}://pair?code=${encodeOffer({ scope: 'mobile' })}`
    const legacyInput = `${scheme}://pair?code=${encodeOffer()}`

    expect(
      decideWebPairingStartup({ initialPairingInput: mobileInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: mobileInput })
    expect(
      decideWebPairingStartup({ initialPairingInput: legacyInput, hasStoredEnvironment: true })
    ).toEqual({ kind: 'show-connect', initialPairingInput: legacyInput })
  })

  it('uses a stored environment when no fresh valid pairing offer is present', () => {
    expect(
      decideWebPairingStartup({ initialPairingInput: null, hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
    expect(
      decideWebPairingStartup({ initialPairingInput: 'not a code', hasStoredEnvironment: true })
    ).toEqual({
      kind: 'use-stored-environment'
    })
  })
})
