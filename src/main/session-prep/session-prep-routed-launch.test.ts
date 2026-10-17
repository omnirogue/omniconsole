import { describe, expect, it, vi } from 'vitest'
import {
  prepareSessionPrepRoutedLaunch,
  type SessionPrepRoutedLaunch
} from './session-prep-routed-launch'

const input: SessionPrepRoutedLaunch = {
  workspace: {
    path: '/project',
    repoId: 'repo',
    isFolder: false,
    isRemote: false,
    hostId: 'local'
  },
  agent: 'codex',
  launch: { model: 'gpt-6-luna', effort: 'medium' },
  routedModel: 'gpt-6-luna'
}
function catalog(model = 'gpt-6-luna', hostId = 'local') {
  return vi.fn().mockResolvedValue({
    hostId,
    observedAt: 1,
    agents: [
      {
        provider: 'codex',
        discovered: true,
        models: [{ id: model, thinkingLevels: [{ id: 'medium' }] }]
      }
    ]
  })
}
describe('prepared session routed account verification', () => {
  it('prepares the ordinary local account once and freezes the exact probe environment', async () => {
    const prepare = vi.fn().mockResolvedValue('/chosen/account')
    const discover = catalog()
    const env = await prepareSessionPrepRoutedLaunch(input, {
      configuredEnv: { CODEX_HOME: '/configured/account', KEEP: 'configured' },
      resolvers: { prepareForCodexLaunch: prepare },
      catalog: discover
    })
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      { runtime: 'host' },
      { CODEX_HOME: '/configured/account', KEEP: 'configured' }
    )
    expect(env).toEqual({ CODEX_HOME: '/chosen/account', KEEP: 'configured' })
    expect(discover.mock.calls[0][1]).toBe(env)
  })
  it('pins the ordinary Codex system lane when the resolver returns null', async () => {
    const env = await prepareSessionPrepRoutedLaunch(input, {
      configuredEnv: {},
      resolvers: { prepareForCodexLaunch: async () => null },
      catalog: catalog()
    })
    expect(env.CODEX_HOME).toMatch(/\/.codex$/)
  })
  it('uses the SSH-selected environment and never selects a local account', async () => {
    const prepare = vi.fn()
    const discover = catalog('gpt-6-luna', 'ssh:remote')
    const remote = {
      ...input,
      workspace: {
        ...input.workspace,
        isRemote: true,
        connectionId: 'remote',
        hostId: 'ssh:remote'
      },
      accountEnv: { CODEX_HOME: '/remote/chosen', OPENAI_API_KEY: '' }
    }
    const env = await prepareSessionPrepRoutedLaunch(remote, {
      configuredEnv: { CODEX_HOME: '/wrong/local' },
      resolvers: { prepareForCodexLaunch: prepare },
      catalog: discover
    })
    expect(env).toEqual(remote.accountEnv)
    expect(discover.mock.calls[0][0].executionTarget).toMatchObject({ connectionId: 'remote' })
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['local', 'ssh'] as const)('refuses an unadvertised model on %s', async (location) => {
    const remote = location === 'ssh'
    const args = remote
      ? {
          ...input,
          workspace: {
            ...input.workspace,
            isRemote: true,
            connectionId: 'remote',
            hostId: 'ssh:remote'
          },
          accountEnv: { CODEX_HOME: '/remote/chosen' }
        }
      : input
    await expect(
      prepareSessionPrepRoutedLaunch(args, {
        configuredEnv: {},
        resolvers: { prepareForCodexLaunch: async () => '/local/chosen' },
        catalog: catalog('gpt-6-astra', remote ? 'ssh:remote' : 'local')
      })
    ).rejects.toThrow('Nothing launched')
  })
  it('preserves Claude account patch and blank auth keys without copying process credentials', async () => {
    const discover = vi.fn().mockResolvedValue({
      hostId: 'local',
      observedAt: 1,
      agents: [{ provider: 'claude', discovered: true, models: [{ id: 'sonnet' }] }]
    })
    const prepare = vi.fn().mockResolvedValue({
      configDir: '/claude/chosen',
      envPatch: { CLAUDE_CONFIG_DIR: '/claude/chosen' },
      stripAuthEnv: true,
      provenance: 'profile'
    })
    const env = await prepareSessionPrepRoutedLaunch(
      {
        ...input,
        agent: 'claude',
        launch: { model: 'sonnet' },
        routedModel: 'sonnet'
      },
      { configuredEnv: {}, resolvers: { prepareForClaudeLaunch: prepare }, catalog: discover }
    )
    expect(env.CLAUDE_CONFIG_DIR).toBe('/claude/chosen')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.PATH).toBeUndefined()
    expect(discover.mock.calls[0][1]).toBe(env)
  })
  it.each(['unprobed', 'wrong-host', 'unsupported-effort', 'unavailable'] as const)(
    'refuses %s evidence',
    async (reason) => {
      const discover = catalog()
      if (reason === 'unavailable') {
        discover.mockRejectedValue(new Error('probe failed'))
      } else {
        discover.mockResolvedValue({
          hostId: reason === 'wrong-host' ? 'other' : 'local',
          observedAt: 1,
          agents: [
            {
              provider: 'codex',
              discovered: reason !== 'unprobed',
              models: [
                {
                  id: 'gpt-6-luna',
                  thinkingLevels: reason === 'unsupported-effort' ? [] : [{ id: 'medium' }]
                }
              ]
            }
          ]
        })
      }
      await expect(
        prepareSessionPrepRoutedLaunch(input, {
          configuredEnv: {},
          resolvers: { prepareForCodexLaunch: async () => '/chosen' },
          catalog: discover
        })
      ).rejects.toThrow('select an available model explicitly')
    }
  )
})
