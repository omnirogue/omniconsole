import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyClaudeSetupTokenDirectory } from './setup-token-directory'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function configDir(token?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-setup-token-'))
  dirs.push(dir)
  if (token !== undefined) {
    writeFileSync(join(dir, '.oauth-token'), token)
  }
  return dir
}

describe('applyClaudeSetupTokenDirectory', () => {
  it('hands the setup token to the launch when the requested config directory carries one', () => {
    const dir = configDir('sk-ant-oat01-example\n')
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: dir }
    expect(applyClaudeSetupTokenDirectory(env, { CLAUDE_CONFIG_DIR: dir })).toBe(true)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-example')
  })

  it('leaves a directory without a token, an explicit token and an inherited directory alone', () => {
    const plain = configDir()
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: plain }
    expect(applyClaudeSetupTokenDirectory(env, { CLAUDE_CONFIG_DIR: plain })).toBe(false)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()

    const withToken = configDir('token')
    const explicit: Record<string, string> = {
      CLAUDE_CONFIG_DIR: withToken,
      CLAUDE_CODE_OAUTH_TOKEN: 'already-set'
    }
    expect(applyClaudeSetupTokenDirectory(explicit, { CLAUDE_CONFIG_DIR: withToken })).toBe(false)
    expect(explicit.CLAUDE_CODE_OAUTH_TOKEN).toBe('already-set')

    // Why: OmniConsole's own process env may name a directory; only the launch request counts.
    const inherited: Record<string, string> = { CLAUDE_CONFIG_DIR: withToken }
    expect(applyClaudeSetupTokenDirectory(inherited, undefined)).toBe(false)
    expect(applyClaudeSetupTokenDirectory(inherited, {})).toBe(false)
    expect(inherited.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('does not apply a token when the effective directory differs from the requested one', () => {
    const requested = configDir('token')
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/somewhere/else' }
    expect(applyClaudeSetupTokenDirectory(env, { CLAUDE_CONFIG_DIR: requested })).toBe(false)
  })
})
