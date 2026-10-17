import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyClaudeEnvPatch,
  shouldStripClaudeAuthEnvForAccount
} from '../claude-accounts/environment'
import {
  applyOmniRogueGatewayEnv,
  ensureOmniRogueGatewayTokenFresh,
  OMNIROGUE_GATEWAY_REFRESH_SKEW_MS,
  resolveOmniRogueGatewayToken,
  setOmniRogueGatewayTokenRefresher,
  syncOmniRogueGatewayRuntimeState
} from './omnirogue-gateway-env'

const token = `or_obp_${'a'.repeat(43)}`
const refreshed = `or_obp_${'b'.repeat(43)}`
afterEach(() => {
  setOmniRogueGatewayTokenRefresher(undefined)
  syncOmniRogueGatewayRuntimeState({
    billing: 'own-login',
    token: null,
    baseUrl: undefined,
    model: undefined,
    expiresAt: undefined
  })
  vi.unstubAllEnvs()
})

describe('credits billing without a local Claude subscription', () => {
  it('populates Claude auth from the lease with no selected account or config patch', () => {
    syncOmniRogueGatewayRuntimeState({ billing: 'omnirogue-credits', token })
    expect(shouldStripClaudeAuthEnvForAccount([], null)).toBe(false)
    const env = applyClaudeEnvPatch({}, {}, { stripAuthEnv: true })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.omnirogue.com')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it.each(['OMNIROGUE_BILLING_MODE', 'ORCA_OMNIROGUE_BILLING_MODE'])(
    'honors %s with no runtime subscription',
    (key) => {
      const env = applyClaudeEnvPatch(
        { [key]: 'omnirogue-credits', OMNIROGUE_OBP_TOKEN: token },
        {},
        { stripAuthEnv: true }
      )
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token)
    }
  )

  it('reads the process billing mode and leased token', () => {
    vi.stubEnv('OMNIROGUE_BILLING_MODE', 'omnirogue-credits')
    vi.stubEnv('ORCA_OMNIROGUE_GATEWAY_TOKEN', token)
    expect(applyClaudeEnvPatch({}, {}).ANTHROPIC_AUTH_TOKEN).toBe(token)
  })

  it('recognizes Windows environment casing and forwards WSL auth variables', () => {
    const env: NodeJS.ProcessEnv = {
      omnirogue_billing_mode: 'omnirogue-credits',
      omnirogue_obp_token: token,
      anthropic_auth_token: 'old-subscription-token'
    }
    applyOmniRogueGatewayEnv({ env, platform: 'win32', launchAgent: 'claude', isWsl: true })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token)
    expect(env.WSLENV).toContain('ANTHROPIC_AUTH_TOKEN')
    expect(env.anthropic_auth_token).toBeUndefined()
  })

  it('does not inject a gateway token into an explicitly own-login launch', () => {
    syncOmniRogueGatewayRuntimeState({ billing: 'omnirogue-credits', token })
    expect(
      applyClaudeEnvPatch({}, {}, { billing: 'own-login' }).ANTHROPIC_AUTH_TOKEN
    ).toBeUndefined()
  })
})

describe('gateway token freshness at launch', () => {
  it('re-leases a token inside the refresh skew before the launch reads it', async () => {
    const now = 1_000_000
    syncOmniRogueGatewayRuntimeState({
      billing: 'omnirogue-credits',
      token,
      expiresAt: now + OMNIROGUE_GATEWAY_REFRESH_SKEW_MS - 1
    })
    const refresh = vi.fn(async () => {
      syncOmniRogueGatewayRuntimeState({ token: refreshed, expiresAt: now + 3_600_000 })
    })
    setOmniRogueGatewayTokenRefresher(refresh)
    await Promise.all([
      ensureOmniRogueGatewayTokenFresh(now),
      ensureOmniRogueGatewayTokenFresh(now)
    ])
    expect(refresh).toHaveBeenCalledOnce()
    // The launch env inherited the old token from process.env; the replaced copy never wins.
    expect(resolveOmniRogueGatewayToken(undefined, { ORCA_OMNIROGUE_GATEWAY_TOKEN: token })).toBe(
      refreshed
    )
    await ensureOmniRogueGatewayTokenFresh(now)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('leaves a fresh token and own-login launches alone', async () => {
    const refresh = vi.fn(async () => {})
    setOmniRogueGatewayTokenRefresher(refresh)
    syncOmniRogueGatewayRuntimeState({
      billing: 'omnirogue-credits',
      token,
      expiresAt: 10_000_000
    })
    await ensureOmniRogueGatewayTokenFresh(1_000)
    syncOmniRogueGatewayRuntimeState({ billing: 'own-login', expiresAt: 1 })
    await ensureOmniRogueGatewayTokenFresh(1_000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps an explicitly passed token even when a refresh replaced it', () => {
    syncOmniRogueGatewayRuntimeState({ billing: 'omnirogue-credits', token })
    syncOmniRogueGatewayRuntimeState({ token: refreshed })
    expect(resolveOmniRogueGatewayToken(token)).toBe(token)
  })
})
