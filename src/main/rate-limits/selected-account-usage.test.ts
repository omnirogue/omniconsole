import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

const { claudeFetch, codexFetch, grokFetch, netFetch } = vi.hoisted(() => ({
  claudeFetch: vi.fn(),
  codexFetch: vi.fn(),
  grokFetch: vi.fn(),
  netFetch: vi.fn()
}))

vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: claudeFetch }))
vi.mock('./codex-backend-usage-client', () => ({ fetchCodexRateLimitsViaBackend: codexFetch }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: grokFetch }))

import { probeSelectedAccountUsage } from './selected-account-usage'

function success(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent: 23, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1_800_000_000_123,
    status: 'ok',
    error: null
  }
}

function grokAuth(token: string): string {
  return JSON.stringify({
    'https://auth.x.ai': { key: token, expires_at: '2099-01-01T00:00:00Z' }
  })
}

describe('probeSelectedAccountUsage', () => {
  let root: string

  beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'omni-selected-account-usage-'))
    claudeFetch.mockResolvedValue(success('claude'))
    codexFetch.mockResolvedValue(success('codex'))
    grokFetch.mockResolvedValue(success('grok'))
    // Usage requests go through the main HTTP port: the runtime boots on plain Node.
    setMainHttpClient({ fetch: netFetch, proxySession: () => null })
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    setMainHttpClient(null)
    await rm(root, { recursive: true, force: true })
  })

  it('uses the live selected Claude login before the setup token or ambient accounts', async () => {
    await writeFile(join(root, '.oauth-token'), ' selected-setup-token\n')
    await writeFile(
      join(root, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'live-login-token', expiresAt: Date.now() + 7 * 3_600_000 }
      })
    )
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-token')
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root
    })

    expect(result).toEqual(success('claude'))
    expect(claudeFetch).toHaveBeenCalledWith('live-login-token', expect.any(AbortSignal))
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('ambient-token')
  })

  it('falls back to the selected setup token once the login credential has expired', async () => {
    await writeFile(join(root, '.oauth-token'), ' selected-setup-token\n')
    await writeFile(
      join(root, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'expired-login-token', expiresAt: Date.now() - 1_000 }
      })
    )
    await probeSelectedAccountUsage({ version: 1, provider: 'claude', configRoot: root })
    expect(claudeFetch).toHaveBeenCalledWith('selected-setup-token', expect.any(AbortSignal))
  })

  it('does not verify a setup token for a launch that will use the login directory', async () => {
    await writeFile(join(root, '.oauth-token'), 'setup-token')
    await writeFile(
      join(root, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'expired-login', expiresAt: Date.now() - 1_000 }
      })
    )
    const result = await probeSelectedAccountUsage(
      { version: 1, provider: 'claude', configRoot: root },
      { claudeLoginOnly: true }
    )
    expect(result.status).toBe('unavailable')
    expect(claudeFetch).not.toHaveBeenCalled()
  })

  it('still sends an expired login credential when no setup token exists', async () => {
    await writeFile(
      join(root, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'expired-login-token', expiresAt: Date.now() - 1_000 }
      })
    )
    await probeSelectedAccountUsage({ version: 1, provider: 'claude', configRoot: root })
    expect(claudeFetch).toHaveBeenCalledWith('expired-login-token', expect.any(AbortSignal))
  })

  it('reads selected Claude OAuth after an empty setup token', async () => {
    await writeFile(join(root, '.oauth-token'), '\n')
    await writeFile(
      join(root, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'selected-oauth-token' } })
    )
    await probeSelectedAccountUsage({ version: 1, provider: 'claude', configRoot: root })
    expect(claudeFetch).toHaveBeenCalledWith('selected-oauth-token', expect.any(AbortSignal))
  })

  it('uses an explicit private Claude token without substituting a home credential', async () => {
    await writeFile(join(root, '.oauth-token'), 'different-home-token')
    await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root,
      token: 'runner-selected-token'
    })
    expect(claudeFetch).toHaveBeenCalledWith('runner-selected-token', expect.any(AbortSignal))
  })

  it('refuses an empty explicit token even when the selected home has credentials', async () => {
    await writeFile(join(root, '.oauth-token'), 'home-token')
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root,
      token: ''
    })
    expect(result.status).toBe('unavailable')
    expect(claudeFetch).not.toHaveBeenCalled()
  })

  it('does not use ambient Claude credentials when the selected directory has none', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/ambient/claude')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-token')
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root
    })
    expect(result.status).toBe('unavailable')
    expect(claudeFetch).not.toHaveBeenCalled()
  })

  it('rejects a Claude credential changed while the usage request was pending', async () => {
    await writeFile(join(root, '.oauth-token'), 'first-token')
    claudeFetch.mockImplementation(async () => {
      await writeFile(join(root, '.oauth-token'), 'replacement-token')
      return success('claude')
    })
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root
    })
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('refuses oversized selected credentials before contacting a provider', async () => {
    await writeFile(join(root, '.oauth-token'), 'x'.repeat(65_537))
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root
    })
    expect(result).toMatchObject({ status: 'error', session: null, weekly: null })
    expect(claudeFetch).not.toHaveBeenCalled()
  })

  it('passes only the exact selected Codex home to the direct backend probe', async () => {
    await writeFile(join(root, 'auth.json'), '{"tokens":{"access_token":"selected-token"}}')
    vi.stubEnv('CODEX_HOME', '/ambient/codex')
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'codex',
      configRoot: root
    })
    expect(result.updatedAt).toBe(success('codex').updatedAt)
    expect(codexFetch).toHaveBeenCalledWith(expect.any(Function), {
      codexHomePath: await realpath(root),
      signal: expect.any(AbortSignal)
    })
    expect(process.env.CODEX_HOME).toBe('/ambient/codex')
  })

  it('rejects Codex auth replaced during the direct backend request', async () => {
    await writeFile(join(root, 'auth.json'), '{"tokens":{"access_token":"first-token"}}')
    codexFetch.mockImplementation(async () => {
      await writeFile(join(root, 'auth.json'), '{"tokens":{"access_token":"other-token"}}')
      return success('codex')
    })
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'codex',
      configRoot: root
    })
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('reports unsupported Codex credentials as unavailable without quota windows', async () => {
    await writeFile(
      join(root, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: 'selected-api-key',
        tokens: { access_token: 'stale-subscription-token' }
      })
    )
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'codex',
      configRoot: root
    })
    expect(result).toMatchObject({ status: 'unavailable', session: null, weekly: null })
    expect(codexFetch).not.toHaveBeenCalled()
  })

  it('refuses a different Codex credential reread before making any HTTP request', async () => {
    await writeFile(join(root, 'auth.json'), '{"tokens":{"access_token":"selected-token"}}')
    const httpFetch = vi.fn()
    setMainHttpClient({ fetch: httpFetch, proxySession: () => null })
    codexFetch.mockImplementation(async (request) =>
      request('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: 'Bearer substituted-token' }
      })
    )
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'codex',
      configRoot: root
    })
    expect(result.status).toBe('error')
    expect(httpFetch).not.toHaveBeenCalled()
  })

  it('passes the selected Grok session directly without using ambient GROK_HOME', async () => {
    await writeFile(join(root, 'auth.json'), grokAuth('selected-grok-token'))
    vi.stubEnv('GROK_HOME', '/ambient/grok')
    await probeSelectedAccountUsage({ version: 1, provider: 'grok', configRoot: root })
    expect(grokFetch).toHaveBeenCalledWith({
      authReadResult: expect.objectContaining({
        status: 'ok',
        session: expect.objectContaining({ accessToken: 'selected-grok-token' })
      }),
      signal: expect.any(AbortSignal)
    })
    expect(process.env.GROK_HOME).toBe('/ambient/grok')
  })

  it('rejects Grok account replacement while billing was pending', async () => {
    await writeFile(join(root, 'auth.json'), grokAuth('first-token'))
    grokFetch.mockImplementation(async () => {
      await writeFile(join(root, 'auth.json'), grokAuth('second-token'))
      return success('grok')
    })
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'grok',
      configRoot: root
    })
    expect(result.status).toBe('error')
    expect(result.session).toBeNull()
  })

  it('uses the selected Kimi token and existing real usage-window mapper', async () => {
    netFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ usage: { limit: '200', used: '50' } })
    })
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'kimi',
      token: 'selected-kimi-token',
      baseUrl: 'https://api.kimi.com/coding/v1/'
    })
    expect(result).toMatchObject({ status: 'ok', weekly: { usedPercent: 25 }, session: null })
    expect(netFetch).toHaveBeenCalledWith('https://api.kimi.com/coding/v1/usages', {
      headers: { Authorization: 'Bearer selected-kimi-token', Accept: 'application/json' },
      signal: expect.any(AbortSignal)
    })
  })

  it.each([
    'https://api.moonshot.ai/v1',
    'https://api.kimi.com.evil.example/coding/v1',
    'http://api.kimi.com/coding/v1',
    'https://api.kimi.com/coding/v1?redirect=elsewhere'
  ])('does not send selected Kimi credentials to unsupported endpoint %s', async (baseUrl) => {
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'kimi',
      token: 'token',
      baseUrl
    })
    expect(result).toMatchObject({ status: 'unavailable', session: null, weekly: null })
    expect(netFetch).not.toHaveBeenCalled()
  })

  it('does not manufacture zero usage when Kimi returns no windows', async () => {
    netFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'kimi',
      token: 'token',
      baseUrl: 'https://api.kimi.com/coding/v1'
    })
    expect(result).toMatchObject({ status: 'error', session: null, weekly: null })
  })

  it('uses a fixed safe failure for thrown errors', async () => {
    claudeFetch.mockRejectedValue(new Error(`private-token ${root}`))
    const result = await probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root,
      token: 'selected-token'
    })
    expect(result.error).toBe('Selected account usage is unavailable')
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('private-token')
  })

  it('bounds an unresponsive probe to ten seconds and aborts its request', async () => {
    vi.useFakeTimers()
    claudeFetch.mockImplementation(() => new Promise(() => {}))
    const pending = probeSelectedAccountUsage({
      version: 1,
      provider: 'claude',
      configRoot: root,
      token: 'selected-token'
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ status: 'error', session: null, weekly: null })
    expect(claudeFetch.mock.calls[0]?.[1].aborted).toBe(true)
  })
})
