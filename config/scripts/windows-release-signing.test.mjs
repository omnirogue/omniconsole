import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { windowsReleaseSigning, verifyWindowsReleaseEnv } = require('./windows-release-signing.cjs')
const azure = {
  OMNI_WINDOWS_RELEASE: '1',
  OMNI_WINDOWS_SIGNING_PROVIDER: 'azure',
  OMNI_WINDOWS_PUBLISHER_NAME: 'Fixture Publisher',
  OMNI_WINDOWS_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
  OMNI_WINDOWS_SIGNING_ACCOUNT: 'fixture-signing',
  OMNI_WINDOWS_SIGNING_PROFILE: 'public-release',
  AZURE_CLIENT_ID: 'fixture-client',
  AZURE_TENANT_ID: 'fixture-tenant',
  AZURE_SUBSCRIPTION_ID: 'fixture-subscription'
}
afterEach(() => vi.unstubAllEnvs())

describe('Windows release signing', () => {
  it('uses cloud signing without requiring an exported certificate or client secret', () => {
    const config = verifyWindowsReleaseEnv(azure)
    expect(config.azureSignOptions).toMatchObject({ publisherName: 'Fixture Publisher' })
    expect(config.signtoolOptions).toBeUndefined()
    expect(() => verifyWindowsReleaseEnv({ ...azure, AZURE_CLIENT_ID: '' })).toThrow(
      'AZURE_CLIENT_ID'
    )
  })

  it('fails closed on incomplete, untrusted or unknown signing configuration', () => {
    for (const name of [
      'OMNI_WINDOWS_PUBLISHER_NAME',
      'OMNI_WINDOWS_SIGNING_ACCOUNT',
      'OMNI_WINDOWS_SIGNING_PROFILE'
    ]) {
      expect(() => windowsReleaseSigning({ ...azure, [name]: '' })).toThrow(name)
    }
    expect(() =>
      windowsReleaseSigning({ ...azure, OMNI_WINDOWS_SIGNING_PROVIDER: 'unsigned' })
    ).toThrow('Unknown')
    for (const endpoint of [
      'http://eus.codesigning.azure.net',
      'https://eus.codesigning.azure.net.attacker.test',
      'https://attacker.test'
    ]) {
      expect(() =>
        windowsReleaseSigning({ ...azure, OMNI_WINDOWS_SIGNING_ENDPOINT: endpoint })
      ).toThrow('endpoint')
    }
  })

  it('retains the existing certificate signing path and requires its credentials', () => {
    const env = { OMNI_WINDOWS_RELEASE: '1', OMNI_WINDOWS_PUBLISHER_NAME: 'Fixture Publisher' }
    expect(() => verifyWindowsReleaseEnv(env)).toThrow('CSC_LINK')
    expect(
      verifyWindowsReleaseEnv({ ...env, CSC_LINK: 'fixture.pfx', CSC_KEY_PASSWORD: 'fixture' })
    ).toEqual({ signtoolOptions: { publisherName: 'Fixture Publisher' } })
  })

  it('keeps signing mandatory and embeds the verified cloud publisher for update verification', () => {
    for (const name of [
      'ORCA_MAC_RELEASE',
      'ORCA_MAC_HOURLY',
      'ORCA_MAC_DAILY',
      'ORCA_MAC_ADHOC',
      'ORCA_WIN_HOURLY',
      'ORCA_WIN_DAILY',
      'ORCA_WIN_ADHOC'
    ]) {
      vi.stubEnv(name, undefined)
    }
    for (const [name, value] of Object.entries(azure)) {
      vi.stubEnv(name, value)
    }
    const path = require.resolve('../electron-builder.config.cjs')
    delete require.cache[path]
    try {
      const config = require(path)
      expect(config.forceCodeSigning).toBe(true)
      expect(config.win.verifyUpdateCodeSignature).not.toBe(false)
      expect(config.win.azureSignOptions.publisherName).toBe('Fixture Publisher')
      expect(config.win.signtoolOptions).toBeUndefined()
    } finally {
      delete require.cache[path]
    }
  })
})
