import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OmniConsoleMcpLaunch from './omni-console-mcp-launch'
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\sal'
}))
vi.mock('./omni-console-mcp-launch', async (original) => ({
  ...(await original<typeof OmniConsoleMcpLaunch>()),
  prepareOmniConsoleMcpForLaunch: vi.fn()
}))
import { prepareOmniConsoleMcpForLaunch } from './omni-console-mcp-launch'
import { prepareOmniConsoleMcpForPty } from './omni-console-mcp-pty'
vi.mock('../team-knowledge/team-knowledge-retirement', () => ({
  retireTeamKnowledge: vi.fn(() => ({ version: 1, status: 'disabled', targets: [] }))
}))
import { retireTeamKnowledge } from '../team-knowledge/team-knowledge-retirement'

beforeEach(() => vi.clearAllMocks())
describe('PTY connector launch boundary', () => {
  it.each(['claude', 'codex', 'gemini', 'grok', 'muse'] as const)(
    'prepares %s on the execution host before launch',
    (launchAgent) => {
      prepareOmniConsoleMcpForPty({
        launchAgent,
        env: { HOME: '/host/account' },
        cwd: '/host/folder'
      })
      expect(prepareOmniConsoleMcpForLaunch).toHaveBeenCalledExactlyOnceWith({
        provider: launchAgent,
        signedIn: true,
        env: { HOME: '/host/account' },
        cwd: '/host/folder'
      })
    }
  )
  it('prepares every provider for a plain shell where the user may type an agent command', () => {
    prepareOmniConsoleMcpForPty({ env: {}, cwd: '/folder' })
    expect(
      vi.mocked(prepareOmniConsoleMcpForLaunch).mock.calls.map(([args]) => args.provider)
    ).toEqual(['claude', 'codex', 'gemini', 'grok', 'muse'])
  })
  it('uses only guest paths for a WSL Grok process', () => {
    prepareOmniConsoleMcpForPty({
      launchAgent: 'grok',
      isWsl: true,
      env: { GROK_HOME: '/home/sal/account' },
      cwd: '/home/sal/folder'
    })
    expect(prepareOmniConsoleMcpForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'grok',
        home: '\\\\wsl.localhost\\Ubuntu\\home\\sal',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\folder',
        env: expect.objectContaining({ GROK_HOME: '\\\\wsl.localhost\\Ubuntu\\home\\sal\\account' })
      })
    )
  })
  it('offers the local headers helper to Claude only, and never to a WSL guest', () => {
    const helper = '/App/Resources/mcp/omni-console-mcp-headers.sh'
    prepareOmniConsoleMcpForPty({ env: {}, cwd: '/folder', claudeHeadersHelper: helper })
    const calls = vi.mocked(prepareOmniConsoleMcpForLaunch).mock.calls.map(([args]) => args)
    expect(calls.find((args) => args.provider === 'claude')?.claudeHeadersHelper).toBe(helper)
    for (const args of calls.filter((args) => args.provider !== 'claude')) {
      expect(args).not.toHaveProperty('claudeHeadersHelper')
    }
    vi.mocked(prepareOmniConsoleMcpForLaunch).mockClear()
    prepareOmniConsoleMcpForPty({
      launchAgent: 'claude',
      isWsl: true,
      env: {},
      cwd: '/home/sal/folder',
      claudeHeadersHelper: helper
    })
    expect(vi.mocked(prepareOmniConsoleMcpForLaunch).mock.calls[0][0]).not.toHaveProperty(
      'claudeHeadersHelper'
    )
  })

  it('propagates a config refusal so an unconfigured process cannot start', () => {
    vi.mocked(prepareOmniConsoleMcpForLaunch).mockImplementationOnce(() => {
      throw new Error('MCP config malformed')
    })
    expect(() => prepareOmniConsoleMcpForPty({ launchAgent: 'gemini', env: {} })).toThrow(
      'MCP config malformed'
    )
  })

  it('passes only execution-host paths and flags to the optional retirement', () => {
    const env = { HOME: '/host/account', OMNI_TEAM_KNOWLEDGE_RETIREMENT: 'dry-run' }
    prepareOmniConsoleMcpForPty({ launchAgent: 'grok', env, userDataPath: '/host/profile' })
    expect(retireTeamKnowledge).toHaveBeenCalledExactlyOnceWith({
      userDataPath: '/host/profile',
      home: '/host/account',
      env
    })
    expect(vi.mocked(prepareOmniConsoleMcpForLaunch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(retireTeamKnowledge).mock.invocationCallOrder[0]
    )
  })
})
