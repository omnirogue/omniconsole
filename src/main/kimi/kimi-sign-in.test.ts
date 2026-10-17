import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readKimiSignIn } from './kimi-sign-in'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-sign-in-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeCredentials(contents: string): Promise<void> {
  await mkdir(join(home, 'credentials'), { recursive: true })
  await writeFile(join(home, 'credentials', 'kimi-code.json'), contents)
}

async function writeConfig(contents: string): Promise<void> {
  await writeFile(join(home, 'config.toml'), contents)
}

describe('readKimiSignIn', () => {
  it('is signed out when neither file exists', async () => {
    expect(await readKimiSignIn(home)).toBe(false)
    expect(await readKimiSignIn(join(home, 'missing'))).toBe(false)
  })

  const inAnHour = Math.floor(Date.now() / 1000) + 3600
  it.each([
    [{ refresh_token: 'fake-refresh', access_token: '' }],
    [{ refresh_token: 'fake-refresh' }],
    // Why: an expired access token still signs in when Kimi can refresh it.
    [{ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: 0 }],
    [{ access_token: 'fake-access', expires_at: inAnHour }],
    [{ access_token: 'fake-access', expires_at: inAnHour * 1000 }]
  ])('accepts a stored OAuth login %#', async (credentials) => {
    await writeCredentials(JSON.stringify(credentials))
    expect(await readKimiSignIn(home)).toBe(true)
  })

  it.each([
    [{ access_token: 'fake-access', expires_at: 0 }],
    [{ access_token: 'fake-access', expires_at: inAnHour - 7200 }],
    [{ access_token: 'fake-access' }],
    [{ access_token: 'fake-access', expires_at: 'soon' }]
  ])('rejects an access token Kimi cannot renew once it is stale %#', async (credentials) => {
    await writeCredentials(JSON.stringify(credentials))
    expect(await readKimiSignIn(home)).toBe(false)
  })

  it('rejects empty or non-string tokens', async () => {
    await writeCredentials(
      JSON.stringify({ access_token: '', refresh_token: '  ', expires_at: 0, scope: 'kimi-code' })
    )
    expect(await readKimiSignIn(home)).toBe(false)
    await writeCredentials(JSON.stringify({ access_token: 42, refresh_token: null }))
    expect(await readKimiSignIn(home)).toBe(false)
  })

  it('accepts an API-key provider in config.toml', async () => {
    await writeConfig(
      [
        'default_model = "kimi-for-coding"',
        '[providers.empty]',
        'type = "kimi"',
        'api_key = ""',
        '[providers.moonshot-ai]',
        'type = "kimi"',
        'api_key = "fake-api-key"'
      ].join('\n')
    )
    expect(await readKimiSignIn(home)).toBe(true)
  })

  it('rejects providers without a usable api_key', async () => {
    await writeConfig(['[providers.managed]', 'type = "kimi"', 'api_key = ""'].join('\n'))
    expect(await readKimiSignIn(home)).toBe(false)
    await writeConfig('providers = "not-a-table"')
    expect(await readKimiSignIn(home)).toBe(false)
  })

  it('treats malformed files as no evidence', async () => {
    await writeCredentials('{not json')
    await writeConfig('[providers.broken\napi_key = ')
    expect(await readKimiSignIn(home)).toBe(false)
  })

  it('still reads the other source when one is malformed', async () => {
    await writeCredentials('{not json')
    await writeConfig(['[providers.p]', 'api_key = "fake-api-key"'].join('\n'))
    expect(await readKimiSignIn(home)).toBe(true)
  })
})
