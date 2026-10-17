import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingUrl, extractPairingCodeFromUrl, parsePairingCode } from './pairing'
import type { PairingOffer } from './types'
import { encodePairingOffer } from '../../../src/shared/pairing'
import mobileConfig from '../../app.json'
import { decodePairingUrl as decodeLegacyPairingUrl } from './legacy-mobile-pairing-reader.fixture'

const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://100.102.47.57:6768',
  deviceToken: 'token-abc',
  publicKeyB64: 'pubkey-xyz'
}

function encodeOffer(input: PairingOffer = offer): string {
  return btoa(JSON.stringify(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('desktop mobile offers open the registered app and work with its frozen older reader', () => {
  const mobileOffer = { ...offer, scope: 'mobile' as const }
  const url = encodePairingOffer(mobileOffer)
  expect(new URL(url).protocol).toBe(`${mobileConfig.expo.scheme}:`)
  expect(decodeLegacyPairingUrl(url)).toEqual(mobileOffer)
  expect(decodePairingUrl(url)).toEqual(mobileOffer)
})

describe.each(['omni', 'orca'])('%s pairing deep links', (scheme) => {
  it('extracts the QR pairing code from the hash payload', () => {
    expect(extractPairingCodeFromUrl(`${scheme}://pair#abc123`)).toBe('abc123')
  })

  it('extracts the pairing code from a query param', () => {
    expect(extractPairingCodeFromUrl(`${scheme}://pair?code=abc123`)).toBe('abc123')
  })

  it('accepts scanner casing and surrounding whitespace', () => {
    expect(extractPairingCodeFromUrl(`  ${scheme.toUpperCase()}://PAIR?code=abc123\n`)).toBe(
      'abc123'
    )
  })

  it('rejects lookalike routes', () => {
    expect(extractPairingCodeFromUrl(`${scheme}://pairing?code=abc123`)).toBeNull()
    expect(extractPairingCodeFromUrl(`${scheme}://pair-extra?code=abc123`)).toBeNull()
  })

  it('prefers the query pairing code when both query and hash are present', () => {
    expect(extractPairingCodeFromUrl(`${scheme}://pair?code=query-code#hash-code`)).toBe(
      'query-code'
    )
  })

  it('ignores empty and unrelated URLs', () => {
    expect(extractPairingCodeFromUrl(`${scheme}://pair`)).toBeNull()
    expect(extractPairingCodeFromUrl('https://example.com/pair#abc123')).toBeNull()
  })

  it('decodes desktop QR payloads when atob requires base64 padding', () => {
    const realAtob = globalThis.atob
    vi.stubGlobal('atob', (input: string) => {
      if (input.length % 4 !== 0) {
        throw new Error('Invalid base64 length')
      }
      return realAtob(input)
    })

    expect(decodePairingUrl(`${scheme}://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('parses a full pairing URL and a bare copied code', () => {
    const code = encodeOffer()

    expect(parsePairingCode(`${scheme}://pair?code=${code}`)).toEqual(offer)
    expect(parsePairingCode(code)).toEqual(offer)
  })

  it('preserves a TLS reverse-proxy endpoint with an explicit port and path', () => {
    const proxiedOffer = {
      ...offer,
      endpoint: 'wss://proxy.example:443/orca/runtime'
    }
    const code = encodeOffer(proxiedOffer)

    expect(parsePairingCode(code)).toEqual(proxiedOffer)
  })
})
