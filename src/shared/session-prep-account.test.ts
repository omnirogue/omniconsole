import { describe, expect, it } from 'vitest'
import {
  isPoolOAuthTokenFile,
  sessionPrepAccountEnv,
  sessionPrepAccountResult,
  type SessionPrepAccount
} from './session-prep-account'

const account: SessionPrepAccount = {
  provider: 'claude',
  configRoot: '/remote/.claude',
  pinConfigDir: false,
  readingAt: 1,
  ageAtReplyMs: 0,
  processingMs: 0,
  remainingPercent: 90
}

describe('execution-host account environment', () => {
  it('clears inherited pins without changing the default Claude login namespace', () => {
    expect(sessionPrepAccountEnv(account)).toMatchObject({
      CLAUDE_CONFIG_DIR: '',
      ANTHROPIC_API_KEY: '',
      AWS_BEARER_TOKEN_BEDROCK: '',
      ANTHROPIC_CUSTOM_HEADERS: ''
    })
    expect(sessionPrepAccountEnv({ ...account, pinConfigDir: true }).CLAUDE_CONFIG_DIR).toBe(
      account.configRoot
    )
  })

  it('keeps the default config and names the host token file for a pool slot', () => {
    const slot = '/Users/cloud/.claude-accounts/sal/slot-9'
    const env = sessionPrepAccountEnv({
      ...account,
      configRoot: slot,
      pinConfigDir: true,
      oauthTokenFile: `${slot}/.oauth-token`
    })
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ORCA_ACCOUNT_OAUTH_TOKEN_FILE: `${slot}/.oauth-token`
    })
  })

  it('accepts only the pool slot token layout', () => {
    expect(isPoolOAuthTokenFile('/Users/cloud/.claude-accounts/sal/slot-9/.oauth-token')).toBe(true)
    for (const path of [
      'relative/.claude-accounts/sal/slot-9/.oauth-token',
      '/Users/cloud/.claude-accounts/sal/slot-codex/.oauth-token',
      '/Users/cloud/.claude-accounts/sal/slot-9/.credentials.json',
      '/Users/cloud/../root/.claude-accounts/sal/slot-9/.oauth-token',
      '/Users/cloud/.claude-accounts/sal/slot-9/.oauth-token\n'
    ]) {
      expect(isPoolOAuthTokenFile(path)).toBe(false)
    }
    expect(
      sessionPrepAccountResult.safeParse({
        ...account,
        ageAtReplyMs: 0,
        oauthTokenFile: '/etc/passwd'
      }).success
    ).toBe(false)
  })

  it('prevents either Codex API key override from beating the selected subscription', () => {
    expect(
      sessionPrepAccountEnv({ ...account, provider: 'codex', configRoot: '/remote/.codex-second' })
    ).toEqual({
      CODEX_HOME: '/remote/.codex-second',
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
      OPENAI_BASE_URL: ''
    })
  })
})
