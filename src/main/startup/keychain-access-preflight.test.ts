import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en', isPackaged: false },
  BrowserWindow: class {},
  Notification: Object.assign(class {}, { isSupported: () => false }),
  safeStorage: {}
}))

const {
  appBundlePath,
  executableFingerprint,
  grantHeldAfterProbe,
  keychainNoticeNeeded,
  parseKeychainPreflightMarker,
  parseSignatureKind,
  prepareKeychainAccessPreflight
} = await import('./keychain-access-preflight')

describe('keychain access preflight', () => {
  it('fingerprints the executable so a reinstalled build reads as new', () => {
    const before = executableFingerprint('/x', '1.0.0', () => ({ ino: 1, size: 10, mtimeMs: 5 }))
    const reinstalled = executableFingerprint('/x', '1.0.0', () => ({
      ino: 2,
      size: 10,
      mtimeMs: 5
    }))
    expect(before).toBe('1.0.0:1:10:5')
    expect(reinstalled).not.toBe(before)
    expect(
      executableFingerprint('/x', '1.0.0', () => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })

  it('announces until a fast probe proves the grant holds for this exact build', () => {
    expect(keychainNoticeNeeded(null, 'a')).toBe(true)
    expect(keychainNoticeNeeded({ version: 1, fingerprint: 'old', grantHeld: true }, 'a')).toBe(
      true
    )
    expect(keychainNoticeNeeded({ version: 1, fingerprint: 'a', grantHeld: false }, 'a')).toBe(true)
    expect(keychainNoticeNeeded({ version: 1, fingerprint: 'a', grantHeld: true }, 'a')).toBe(false)
  })

  it('treats a probe that waited on a person as no proof of a lasting grant', () => {
    expect(grantHeldAfterProbe(true, 40)).toBe(true)
    // "Allow" rather than "Always Allow" answers one launch only.
    expect(grantHeldAfterProbe(true, 619_000)).toBe(false)
    expect(grantHeldAfterProbe(false, 40)).toBe(false)
  })

  it('reads only well-formed markers', () => {
    expect(
      parseKeychainPreflightMarker('{"version":1,"fingerprint":"a","grantHeld":true}')
    ).toEqual({ version: 1, fingerprint: 'a', grantHeld: true })
    expect(parseKeychainPreflightMarker('{"version":2,"fingerprint":"a"}')).toBeNull()
    expect(parseKeychainPreflightMarker('not json')).toBeNull()
  })

  it('tells ad-hoc builds from certificate-signed ones', () => {
    expect(parseSignatureKind('Identifier=com.omniconsole.ide\nSignature=adhoc\n')).toBe('adhoc')
    expect(
      parseSignatureKind('Authority=Apple Development: Sal (X)\nAuthority=Apple Root CA\n')
    ).toBe('stable')
    expect(parseSignatureKind('code object is not signed at all')).toBe('unknown')
  })

  it('finds the bundle from the main executable path', () => {
    expect(appBundlePath('/Applications/OmniConsole.app/Contents/MacOS/OmniConsole')).toBe(
      '/Applications/OmniConsole.app'
    )
    expect(appBundlePath('/usr/local/bin/node')).toBeNull()
  })

  it('does nothing outside a packaged macOS build', () => {
    expect(prepareKeychainAccessPreflight({ userDataPath: '/tmp/x', headless: false })).toBeNull()
  })

  it('runs before the store is constructed, and only yields when it has to announce', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const prepare = source.indexOf(
      'const keychainAccessPreflight = prepareKeychainAccessPreflight({'
    )
    const run = source.indexOf('await keychainAccessPreflight()')
    const store = source.indexOf('store = new Store({')
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(run).toBeGreaterThan(prepare)
    expect(store).toBeGreaterThan(run)
    expect(source.slice(prepare, run)).toContain('if (keychainAccessPreflight) {')
    expect(source.slice(prepare, store)).toContain('headless: isServeMode')
  })
})
