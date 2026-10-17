import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKFLOW_CODEX_REFRESH_INTERVAL_MS,
  workflowCodexLoginRefreshesWithin,
  workflowCodexRefreshDue
} from './local-workflow-codex-launch'

const DAY = 24 * 60 * 60_000
const jwt = (payload: object) =>
  ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')
const auth = (exp: number, lastRefresh: unknown, refresh: unknown = 'fixture-refresh') =>
  JSON.stringify({
    tokens: { access_token: jwt({ exp: exp / 1000 }), refresh_token: refresh },
    last_refresh: lastRefresh
  })
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('Codex login refresh', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')

  it('is due at the access expiry or when the last refresh turns stale, whichever comes first', () => {
    const lastRefresh = new Date(now - DAY).toISOString()
    expect(workflowCodexRefreshDue(auth(now + 10 * DAY, lastRefresh))).toBe(
      now - DAY + WORKFLOW_CODEX_REFRESH_INTERVAL_MS
    )
    expect(workflowCodexRefreshDue(auth(now + 60_000, lastRefresh))).toBe(now + 60_000)
  })

  it('has nothing to refresh without a rotating refresh token', () => {
    expect(workflowCodexRefreshDue(JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }))).toBeNull()
    expect(workflowCodexRefreshDue(auth(now, new Date(now).toISOString(), null))).toBeNull()
  })

  it('cannot tell from an unreadable login, a token without expiry or no refresh time', () => {
    expect(workflowCodexRefreshDue('not json')).toBeUndefined()
    expect(workflowCodexRefreshDue('null')).toBeUndefined()
    expect(workflowCodexRefreshDue(auth(now, 'yesterday'))).toBeUndefined()
    expect(
      workflowCodexRefreshDue(
        JSON.stringify({
          tokens: { access_token: 'opaque', refresh_token: 'fixture-refresh' },
          last_refresh: new Date(now).toISOString()
        })
      )
    ).toBeUndefined()
  })

  it('shares the account only while the login outlasts the call, and never when unsure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-codex-login-'))
    homes.push(home)
    const write = (text: string) => writeFileSync(join(home, 'auth.json'), text)
    const current = Date.now()
    write(auth(current + 10 * DAY, new Date(current).toISOString()))
    await expect(workflowCodexLoginRefreshesWithin(home, 50 * 60_000)).resolves.toBe(false)
    write(auth(current + 30 * 60_000, new Date(current).toISOString()))
    await expect(workflowCodexLoginRefreshesWithin(home, 50 * 60_000)).resolves.toBe(true)
    write(auth(current + 10 * DAY, new Date(current - 9 * DAY).toISOString()))
    await expect(workflowCodexLoginRefreshesWithin(home, 50 * 60_000)).resolves.toBe(true)
    write(JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }))
    await expect(workflowCodexLoginRefreshesWithin(home, 50 * 60_000)).resolves.toBe(false)
    rmSync(join(home, 'auth.json'))
    await expect(workflowCodexLoginRefreshesWithin(home, 50 * 60_000)).resolves.toBe(true)
  })
})
