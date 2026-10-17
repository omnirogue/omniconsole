import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe('resolveAgentLaunchCommand bypassShellFunctions', () => {
  it.skipIf(process.platform === 'win32')(
    'applies the selected profile after shell startup without expanding its path',
    () => {
      const profile = "/remote/a user's profile/$HOME"
      const result = resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {
          claude: 'sh -c \'printf "%s|%s\\n" "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}"\''
        },
        platform: 'darwin',
        shell: 'posix',
        accountConfigEnv: { CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: '' }
      })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.error)
      }
      const output = execFileSync(
        '/bin/sh',
        [
          '-c',
          `export CLAUDE_CONFIG_DIR=/startup/profile ANTHROPIC_API_KEY=fixture-only; ${result.command}`
        ],
        { encoding: 'utf8' }
      )
      // Why: a blank override must be unset, not exported empty (Claude reads '' as a path).
      expect(output).toBe(`${profile}|unset\n`)
      expect(result.commandWithoutSessionOptions).toBe(result.command)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'unsets the config dir for the default profile even when shell startup pinned one',
    () => {
      const result = resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: { claude: 'sh -c \'printf "%s\\n" "${CLAUDE_CONFIG_DIR-unset}"\'' },
        platform: 'darwin',
        shell: 'posix',
        accountConfigEnv: { CLAUDE_CONFIG_DIR: '', CLAUDE_CODE_OAUTH_TOKEN: '' }
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.command.startsWith('unset CLAUDE_CONFIG_DIR CLAUDE_CODE_OAUTH_TOKEN; ')).toBe(
        true
      )
      const output = execFileSync(
        '/bin/sh',
        ['-c', `export CLAUDE_CONFIG_DIR=/startup/slot-1; ${result.command}`],
        { encoding: 'utf8' }
      )
      expect(output).toBe('unset\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reads a pool slot token on the host and never carries it in the command',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'pool-token-'))
      const tokenFile = join(home, '.claude-accounts', 'sal', 'slot-9', '.oauth-token')
      mkdirSync(join(home, '.claude-accounts', 'sal', 'slot-9'), { recursive: true })
      writeFileSync(tokenFile, 'fixture-slot-token\n', { mode: 0o600 })
      const result = resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {
          claude:
            'sh -c \'printf "%s|%s\\n" "${CLAUDE_CONFIG_DIR-unset}" "$CLAUDE_CODE_OAUTH_TOKEN"\''
        },
        platform: 'darwin',
        shell: 'posix',
        accountConfigEnv: {
          CLAUDE_CONFIG_DIR: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          ORCA_ACCOUNT_OAUTH_TOKEN_FILE: tokenFile
        }
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.command).not.toContain('fixture-slot-token')
      expect(result.command).not.toContain('ORCA_ACCOUNT_OAUTH_TOKEN_FILE')
      const output = execFileSync(
        '/bin/sh',
        [
          '-c',
          `export CLAUDE_CONFIG_DIR=/startup/slot-1 CLAUDE_CODE_OAUTH_TOKEN=stale; ${result.command}`
        ],
        { encoding: 'utf8' }
      )
      // The default config stays (rules, hooks, skills); only the subscription comes from the slot.
      expect(output).toBe('unset|fixture-slot-token\n')
    }
  )

  it('refuses a token file outside the pool layout', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {},
        platform: 'darwin',
        shell: 'posix',
        accountConfigEnv: {
          ORCA_ACCOUNT_OAUTH_TOKEN_FILE: '/etc/../Users/x/.claude-accounts/sal/slot-1/.oauth-token'
        }
      })
    ).toMatchObject({ ok: false })
  })

  it('refuses account pinning on a shell whose assignment syntax is not supported', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {},
        platform: 'win32',
        shell: 'powershell',
        accountConfigEnv: { CLAUDE_CONFIG_DIR: '/remote/profile' }
      })
    ).toMatchObject({ ok: false })
  })

  it('reaches the CLI past shell functions on sh-family shells only', () => {
    const posix = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      agentArgs: '--dangerously-skip-permissions',
      bypassShellFunctions: true
    })
    expect(posix).toMatchObject({
      ok: true,
      command: "command claude '--dangerously-skip-permissions'"
    })
    const powershell = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      bypassShellFunctions: true
    })
    expect(powershell.ok && powershell.command.startsWith('command ')).toBe(false)
  })

  it('never rewrites an explicit command override and stays off by default', () => {
    const overridden = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: { claude: '/opt/claude/bin/claude' },
      platform: 'darwin',
      shell: 'posix',
      bypassShellFunctions: true
    })
    expect(overridden).toMatchObject({ ok: true, command: '/opt/claude/bin/claude' })
    const plain = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix'
    })
    expect(plain).toMatchObject({ ok: true, command: 'claude' })
  })
})
