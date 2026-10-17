import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyPoolOAuthTokenFileEnv,
  listPoolOAuthTokenFiles,
  readPoolOAuthToken
} from './pool-oauth-token-file'

function home(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'pool-home-')))
}

function slot(root: string, name: string, token: string | null, kind?: string): string {
  const dir = join(root, '.claude-accounts', 'sal', name)
  mkdirSync(dir, { recursive: true })
  if (kind !== undefined) {
    writeFileSync(join(dir, '.slot-kind'), `${kind}\n`)
  }
  if (token !== null) {
    writeFileSync(join(dir, '.oauth-token'), `${token}\n`, { mode: 0o600 })
  }
  return join(dir, '.oauth-token')
}

describe.skipIf(process.platform === 'win32')('pool slot token files', () => {
  it('lists setup-token slots only and reads a private token', async () => {
    const root = home()
    const nine = slot(root, 'slot-9', 'fixture-nine', 'setup-token')
    const ten = slot(root, 'slot-10', 'fixture-ten')
    slot(root, 'slot-11', 'fixture-login', 'refreshable')
    slot(root, 'slot-codex', 'fixture-marker')
    slot(root, 'slot-12', null, 'setup-token')
    expect(await listPoolOAuthTokenFiles(root)).toEqual([ten, nine])
    expect(await readPoolOAuthToken(nine, root)).toBe('fixture-nine')
  })

  it('refuses a token others can read, or one that resolves outside the pool', async () => {
    const root = home()
    const open = slot(root, 'slot-1', 'fixture-open')
    chmodSync(open, 0o644)
    await expect(readPoolOAuthToken(open, root)).rejects.toThrow(/private/)
    const outside = join(root, 'elsewhere')
    writeFileSync(outside, 'fixture-outside\n', { mode: 0o600 })
    const dir = join(root, '.claude-accounts', 'sal', 'slot-2')
    mkdirSync(dir, { recursive: true })
    symlinkSync(outside, join(dir, '.oauth-token'))
    await expect(readPoolOAuthToken(join(dir, '.oauth-token'), root)).rejects.toThrow(/outside/)
    await expect(readPoolOAuthToken('/etc/passwd', root)).rejects.toThrow(/pool slot/)
  })

  it('swaps the named file for the token in a helper environment', async () => {
    const root = home()
    const file = slot(root, 'slot-3', 'fixture-three')
    const env: Record<string, string> = {
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ORCA_ACCOUNT_OAUTH_TOKEN_FILE: file
    }
    await applyPoolOAuthTokenFileEnv(env, root)
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-three' })
    const untouched: Record<string, string> = { CLAUDE_CONFIG_DIR: '' }
    await applyPoolOAuthTokenFileEnv(untouched, root)
    expect(untouched).toEqual({ CLAUDE_CONFIG_DIR: '' })
  })
})
