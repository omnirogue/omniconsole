import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  carryBackWorkflowGrokAuth,
  workflowGrokAuthExpiry,
  workflowGrokLoginExpiresWithin
} from './local-workflow-grok-launch'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// The shape of ~/.grok/auth.json (1.0.34): one login per issuer and client, with its expiry.
function auth(expiresAt: string, token: string): string {
  return JSON.stringify({
    'https://auth.x.ai::client': { key: token, refresh_token: token, expires_at: expiresAt }
  })
}

const HOUR = 60 * 60_000
const at = (offset: number) => new Date(Date.now() + offset).toISOString()

function homes(accountExpiry = at(HOUR)) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-grok-auth-'))
  directories.push(root)
  const account = join(root, 'account')
  const home = join(root, 'attempt', 'grok-home')
  mkdirSync(account)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(account, 'auth.json'), auth(accountExpiry, 'account token'))
  return { account, home }
}

describe('Grok login expiry', () => {
  it('reads the latest expiry and ignores unreadable files', () => {
    const text = JSON.stringify({
      a: { expires_at: '2026-09-22T02:12:50.229266Z' },
      b: { expires_at: '2026-09-22T04:00:00Z' },
      c: { expires_at: 42 }
    })
    expect(workflowGrokAuthExpiry(text)).toBe(Date.parse('2026-09-22T04:00:00Z'))
    expect(workflowGrokAuthExpiry('{}')).toBeUndefined()
    expect(workflowGrokAuthExpiry('not json')).toBeUndefined()
  })

  it('queues only launches that could outlive the account login', async () => {
    const soon = homes(at(10 * 60_000))
    expect(await workflowGrokLoginExpiresWithin(soon.account, 20 * 60_000)).toBe(true)
    expect(await workflowGrokLoginExpiresWithin(soon.account, 5 * 60_000)).toBe(false)
    // No OAuth login (an API key account): nothing to refresh, so nothing to queue.
    expect(await workflowGrokLoginExpiresWithin(join(soon.account, 'missing'), HOUR)).toBe(false)
  })
})

describe('Grok private-home token carry-back', () => {
  it('copies a login the CLI refreshed inside the private home back to the account', async () => {
    const { account, home } = homes()
    writeFileSync(join(home, 'auth.json'), auth(at(6 * HOUR), 'refreshed token'))
    await carryBackWorkflowGrokAuth(home, account)
    expect(readFileSync(join(account, 'auth.json'), 'utf8')).toContain('refreshed token')
    expect(statSync(join(account, 'auth.json')).mode & 0o777).toBe(0o600)
    // Attempt folders are kept, so the live login copy never stays behind in one.
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(readdirSync(account)).toEqual(['auth.json'])
  })

  it('leaves the account alone while the private home still links to it', async () => {
    const { account, home } = homes()
    symlinkSync(join(account, 'auth.json'), join(home, 'auth.json'))
    await carryBackWorkflowGrokAuth(home, account)
    expect(readFileSync(join(account, 'auth.json'), 'utf8')).toContain('account token')
    expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true)
  })

  it('never replaces a login that lasts as long, whatever the file times say', async () => {
    const { account, home } = homes(at(6 * HOUR))
    // Written after the account file, but refreshed earlier (a slower parallel attempt).
    writeFileSync(join(home, 'auth.json'), auth(at(5 * HOUR), 'older login'))
    await carryBackWorkflowGrokAuth(home, account)
    expect(readFileSync(join(account, 'auth.json'), 'utf8')).toContain('account token')
    // Not carried back, but not kept either.
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
  })

  it('deletes the private login even when the account cannot take it', async () => {
    const { account, home } = homes(at(-HOUR))
    writeFileSync(join(home, 'auth.json'), auth(at(6 * HOUR), 'refreshed token'))
    await carryBackWorkflowGrokAuth(home, join(account, 'missing'))
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(readdirSync(account)).toEqual(['auth.json'])
  })

  it('carries a later refresh back even after an earlier carry-back rewrote the account', async () => {
    const { account, home } = homes(at(-HOUR))
    const first = join(home, '..', '..', 'first', 'grok-home')
    mkdirSync(first, { recursive: true })
    writeFileSync(join(first, 'auth.json'), auth(at(5 * HOUR), 'first refresh'))
    writeFileSync(join(home, 'auth.json'), auth(at(6 * HOUR), 'second refresh'))
    await carryBackWorkflowGrokAuth(first, account)
    await carryBackWorkflowGrokAuth(home, account)
    expect(readFileSync(join(account, 'auth.json'), 'utf8')).toContain('second refresh')
  })
})
