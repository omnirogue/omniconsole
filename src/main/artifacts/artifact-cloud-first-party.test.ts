import { describe, expect, it } from 'vitest'

import { isFirstPartyCloudHost } from './artifact-cloud-first-party'

describe('isFirstPartyCloudHost', () => {
  const auth = 'https://console.example.com'
  it('accepts the sign-in host, its sibling subdomains, and loopback', () => {
    expect(isFirstPartyCloudHost('https://console.example.com', auth)).toBe(true)
    expect(isFirstPartyCloudHost('https://share.omnirogue.com', auth)).toBe(true)
    expect(isFirstPartyCloudHost('http://127.0.0.1:3000', auth)).toBe(true)
    expect(isFirstPartyCloudHost('http://localhost:4100', auth)).toBe(true)
  })
  it('refuses third-party hosts, including the upstream default', () => {
    expect(isFirstPartyCloudHost('https://share.onorca.dev', auth)).toBe(false)
    expect(isFirstPartyCloudHost('https://omnirogue.com.evil.example', auth)).toBe(false)
    expect(isFirstPartyCloudHost('not a url', auth)).toBe(false)
  })
})
