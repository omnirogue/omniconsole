import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMacReleaseEnvironmentErrors } from './verify-macos-release-env.mjs'

const installed = {
  CSC_NAME: 'Developer ID Application: Fixture Company (ABCDE12345)',
  APPLE_TEAM_ID: 'ABCDE12345',
  APPLE_KEYCHAIN_PROFILE: 'Fixture-Notary'
}
const imported = {
  CSC_LINK: '/fixture/certificate.p12',
  CSC_KEY_PASSWORD: 'fixture-password',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'fixture-app-password',
  APPLE_TEAM_ID: 'ABCDE12345'
}
const script = resolve(import.meta.dirname, 'verify-macos-release-env.mjs')

afterEach(() => vi.unstubAllEnvs())

describe('macOS release signing environment', () => {
  it('accepts installed Developer ID and a saved notarization profile without exporting a key', () => {
    expect(getMacReleaseEnvironmentErrors(installed)).toEqual([])
    expect(execFileSync(process.execPath, [script], { env: installed, encoding: 'utf8' })).toBe('')
  })

  it('retains imported-certificate and Apple-ID notarization support', () => {
    expect(getMacReleaseEnvironmentErrors(imported)).toEqual([])
    expect(getMacReleaseEnvironmentErrors({ ...imported, CSC_NAME: installed.CSC_NAME })).toEqual(
      []
    )
  })

  it('allows a selected keychain profile with an imported certificate', () => {
    const { APPLE_ID: _appleId, APPLE_APP_SPECIFIC_PASSWORD: _password, ...certificate } = imported
    expect(
      getMacReleaseEnvironmentErrors({ ...certificate, APPLE_KEYCHAIN_PROFILE: 'Fixture-Notary' })
    ).toEqual([])
  })

  it.each([
    { CSC_NAME: undefined },
    { CSC_NAME: '-' },
    { CSC_NAME: 'Apple Development: Fixture Company (ABCDE12345)' },
    { CSC_NAME: 'Developer ID Application: Fixture Company (OTHER12345)' },
    { APPLE_TEAM_ID: '' },
    { APPLE_TEAM_ID: 'wrong' },
    { APPLE_KEYCHAIN_PROFILE: '' },
    { APPLE_KEYCHAIN_PROFILE: 'name\nother' },
    { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    { CSC_LINK: '/fixture/certificate.p12' },
    { APPLE_ID: 'ambient@example.com' },
    { APPLE_API_KEY: '/fixture/ambient-key.p8' }
  ])('refuses incomplete, mismatched or ambiguous installed signing inputs: %j', (change) => {
    expect(getMacReleaseEnvironmentErrors({ ...installed, ...change }).length).toBeGreaterThan(0)
  })

  it.each([
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID'
  ])('still refuses missing %s on the imported-certificate path', (key) => {
    expect(getMacReleaseEnvironmentErrors({ ...imported, [key]: '' }).length).toBeGreaterThan(0)
  })

  it('uses the keychain-profile branch supported by the locked electron-builder implementation', () => {
    const keys = [
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'APPLE_KEYCHAIN'
    ]
    for (const key of keys) {
      vi.stubEnv(key, undefined)
    }
    for (const [key, value] of Object.entries(installed)) {
      vi.stubEnv(key, value)
    }
    const require = createRequire(import.meta.url)
    const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper')
    expect(MacTargetHelper.getNotarizeOptions('/fixture/OmniConsole.app')).toEqual({
      tool: 'notarytool',
      appPath: '/fixture/OmniConsole.app',
      keychainProfile: 'Fixture-Notary'
    })
  })

  it('reports configuration names without printing supplied credential values', () => {
    const result = spawnSync(process.execPath, [script], {
      env: { ...installed, APPLE_APP_SPECIFIC_PASSWORD: 'DO-NOT-PRINT-THIS-FIXTURE' },
      encoding: 'utf8'
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('APPLE_KEYCHAIN_PROFILE')
    expect(result.stderr).not.toContain('DO-NOT-PRINT-THIS-FIXTURE')
    expect(result.stdout).toBe('')
  })
})
