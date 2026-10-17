import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { remoteSessionSourceRootsFromEnvironment } from './remote-session-scanner-source-roots'
import { remoteSessionSources } from './remote-session-scanner-sources'
import { MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'

const linux = getRemoteHostPlatform('linux-x64')

describe('relay-owned source roots', () => {
  it('uses only explicitly supplied owning-host environment values', () => {
    expect(remoteSessionSourceRootsFromEnvironment({}, '/remote', linux)).toEqual({})
    expect(
      remoteSessionSourceRootsFromEnvironment(
        {
          GROK_HOME: ' /profiles/grok ',
          KIMI_CODE_HOME: '~/profiles/kimi'
        },
        '/remote',
        linux
      )
    ).toEqual({
      grokHome: '/profiles/grok',
      kimiCodeHome: '/remote/profiles/kimi'
    })
  })

  it('retains the owning Windows path flavor', () => {
    const host = getRemoteHostPlatform('win32-x64')
    const roots = remoteSessionSourceRootsFromEnvironment(
      {
        GROK_HOME: 'D:\\profiles\\grok',
        KIMI_CODE_HOME: '~/profiles/kimi'
      },
      'C:/Users/Remote',
      host
    )
    const sources = remoteSessionSources('C:/Users/Remote', host, roots)
    expect(sources.find((source) => source.agent === 'grok')?.rootDir.replace(/\\/g, '/')).toBe(
      'D:/profiles/grok/sessions'
    )
    expect(sources.find((source) => source.agent === 'kimi')?.rootDir.replace(/\\/g, '/')).toBe(
      'C:/Users/Remote/profiles/kimi/sessions'
    )
  })

  it.each(['relative/home', '/root/\0invalid'])(
    'refuses invalid configured roots explicitly',
    (value) => {
      expect(() =>
        remoteSessionSourceRootsFromEnvironment({ GROK_HOME: value }, '/remote', linux)
      ).toThrow(/GROK_HOME must name an absolute directory/)
      expect(() =>
        remoteSessionSourceRootsFromEnvironment({ KIMI_CODE_HOME: value }, '/remote', linux)
      ).toThrow(/KIMI_CODE_HOME must name an absolute directory/)
    }
  )

  it('uses a typed Rovo sessions-root option without inventing a provider environment variable', () => {
    const sources = remoteSessionSources('/remote', linux, {
      rovoSessionsDir: '/profiles/rovo/sessions'
    })
    expect(sources.find((source) => source.agent === 'rovo')?.rootDir).toBe(
      '/profiles/rovo/sessions'
    )
  })

  it('discovers sessions from relay-owned custom homes through the provider', async () => {
    const sourceRoots = remoteSessionSourceRootsFromEnvironment(
      {
        GROK_HOME: '/profiles/grok',
        KIMI_CODE_HOME: '~/profiles/kimi'
      },
      '/remote',
      linux
    )
    const provider = new MemoryRemoteProvider()
    const grokPath = '/profiles/grok/sessions/project/grok-session/summary.json'
    const kimiPath = '/remote/profiles/kimi/sessions/wd_project_hash/session_custom/state.json'
    provider.addFile(
      grokPath,
      JSON.stringify({ info: { id: 'grok-session' }, generated_title: 'Grok custom home' }),
      10
    )
    provider.addFile(
      kimiPath,
      JSON.stringify({
        id: 'session_custom',
        title: 'Kimi custom home',
        agents: { main: { type: 'main' } }
      }),
      10
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'local',
      remoteHome: '/remote',
      hostPlatform: linux,
      sourceRoots,
      unlimited: true
    })

    expect(result.issues).toEqual([])
    expect(
      result.sessions.map(({ agent, sessionId, filePath }) => ({ agent, sessionId, filePath }))
    ).toEqual(
      expect.arrayContaining([
        { agent: 'grok', sessionId: 'grok-session', filePath: grokPath },
        { agent: 'kimi', sessionId: 'session_custom', filePath: kimiPath }
      ])
    )
    expect(result.sessions).toHaveLength(2)
    expect(provider.readDirPaths).not.toContain('/remote/.grok/sessions')
    expect(provider.readDirPaths).not.toContain('/remote/.kimi-code/sessions')
  })
})
