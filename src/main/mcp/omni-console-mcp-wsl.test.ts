import { describe, expect, it } from 'vitest'
import { resolveOmniConsoleMcpWslPaths } from './omni-console-mcp-wsl'

describe('MCP WSL execution paths', () => {
  it('uses the guest home and selected provider homes through the distro filesystem', () => {
    const resolved = resolveOmniConsoleMcpWslPaths({
      distro: 'Ubuntu',
      home: '\\\\wsl.localhost\\Ubuntu\\home\\sal',
      cwd: '/home/sal/repo',
      env: {
        CODEX_HOME: '/home/sal/codex-account',
        CLAUDE_CONFIG_DIR: '/home/sal/claude-account',
        GROK_HOME: '/home/sal/grok-account',
        GEMINI_CLI_HOME: '/home/sal/gemini-account'
      }
    })
    expect(resolved).toMatchObject({
      home: '\\\\wsl.localhost\\Ubuntu\\home\\sal',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\repo',
      env: {
        CODEX_HOME: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\codex-account',
        CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\claude-account',
        GROK_HOME: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\grok-account',
        GEMINI_CLI_HOME: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\gemini-account'
      }
    })
  })

  it('defaults to the guest account files and preserves a resolved selected home', () => {
    const home = '\\\\wsl.localhost\\Ubuntu\\home\\sal'
    expect(resolveOmniConsoleMcpWslPaths({ distro: 'Ubuntu', home, env: {} }).env).toMatchObject({
      CODEX_HOME: `${home}\\.codex`,
      CLAUDE_CONFIG_DIR: ''
    })
    expect(
      resolveOmniConsoleMcpWslPaths({
        distro: 'Ubuntu',
        home,
        env: { CODEX_HOME: `${home}\\account` }
      }).env.CODEX_HOME
    ).toBe(`${home}\\account`)
  })

  it('refuses a different guest or unresolved host home', () => {
    expect(() =>
      resolveOmniConsoleMcpWslPaths({
        distro: 'Ubuntu',
        home: '\\\\wsl.localhost\\Debian\\home\\sal',
        env: {}
      })
    ).toThrow('WSL home')
  })
})
