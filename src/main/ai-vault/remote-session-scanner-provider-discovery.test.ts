import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { remoteSessionSources } from './remote-session-scanner-sources'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

afterEach(() => vi.unstubAllEnvs())

describe('remote provider source discovery', () => {
  it('registers every file-based provider; OpenCode uses its dedicated database capture', () => {
    expect(
      [
        ...new Set(
          remoteSessionSources('/remote', getRemoteHostPlatform('linux-x64')).map(
            (source) => source.agent
          )
        )
      ].sort()
    ).toEqual(AI_VAULT_AGENTS.filter((agent) => agent !== 'opencode').sort())
  })

  it('does not resolve remote source roots through the dispatcher environment', () => {
    vi.stubEnv('GROK_HOME', '/client/grok')
    vi.stubEnv('KIMI_CODE_HOME', '/client/kimi')
    const sources = remoteSessionSources('/remote', getRemoteHostPlatform('linux-x64'))
    expect(sources.find((source) => source.agent === 'grok')?.rootDir).toBe(
      '/remote/.grok/sessions'
    )
    expect(sources.find((source) => source.agent === 'kimi')?.rootDir).toBe(
      '/remote/.kimi-code/sessions'
    )
    expect(sources.find((source) => source.agent === 'rovo')?.rootDir).toBe(
      '/remote/.rovodev/sessions'
    )
  })

  it.each([
    ['linux-x64', '/home/remote'],
    ['darwin-arm64', '/Users/remote'],
    ['win32-x64', 'C:/Users/remote']
  ] as const)(
    'discovers missing-path metadata providers on %s through the owning filesystem',
    async (platform, remoteHome) => {
      const provider = new MemoryRemoteProvider()
      const grokPath = `${remoteHome}/.grok/sessions/project/grok-session/summary.json`
      provider.addFile(
        grokPath,
        JSON.stringify({ info: { id: 'grok-session', cwd: '/project' }, num_chat_messages: 2 }),
        10
      )
      provider.addFile(
        grokPath.replace('summary.json', 'chat_history.jsonl'),
        jsonLines([
          { type: 'user', content: 'Read the full Grok conversation' },
          { type: 'assistant', content: 'Grok source found' }
        ]),
        11
      )
      const rovoPath = `${remoteHome}/.rovodev/sessions/rovo-session/metadata.json`
      provider.addFile(rovoPath, JSON.stringify({ title: 'Rovo title', cwd: '/project' }), 10)
      provider.addFile(
        rovoPath.replace('metadata.json', 'session_context.json'),
        JSON.stringify({
          messages: [
            { role: 'user', content: 'Read Rovo history' },
            { role: 'assistant', content: 'Rovo source found' }
          ]
        }),
        12
      )
      const kimiPath = `${remoteHome}/.kimi-code/sessions/wd_project_hash/session_kimi/state.json`
      provider.addFile(
        kimiPath,
        JSON.stringify({
          id: 'session_kimi',
          title: 'Kimi title',
          agents: { primary: { type: 'main' } }
        }),
        10
      )
      provider.addFile(
        kimiPath.replace('state.json', 'agents/primary/wire.jsonl'),
        jsonLines([
          {
            type: 'context.append_message',
            message: { role: 'user', origin: { kind: 'user' }, content: 'Read Kimi history' }
          },
          {
            type: 'context.append_loop_event',
            event: { type: 'content.part', part: { type: 'text', text: 'Kimi source found' } }
          },
          { type: 'context.append_loop_event', event: { type: 'step.end' } }
        ]),
        13
      )
      provider.addFile(
        `${remoteHome}/.kimi-code/session_index.jsonl`,
        jsonLines([{ sessionId: 'session_kimi', workDir: '/project' }]),
        10
      )

      const result = await scanRemoteAiVaultSessions({
        provider,
        executionHostId: 'ssh:rented-mac',
        remoteHome,
        hostPlatform: getRemoteHostPlatform(platform),
        unlimited: true
      })

      expect(result.issues).toEqual([])
      expect(result.sessions).toHaveLength(3)
      for (const [agent, sessionId, filePath, title] of [
        ['grok', 'grok-session', grokPath, 'Read the full Grok conversation'],
        ['rovo', 'rovo-session', rovoPath, 'Rovo title'],
        ['kimi', 'session_kimi', kimiPath, 'Kimi title']
      ]) {
        expect(result.sessions.find((session) => session.agent === agent)).toMatchObject({
          agent,
          sessionId,
          title,
          executionHostId: 'ssh:rented-mac',
          cwd: '/project',
          messageCount: 2
        })
        expect(
          result.sessions.find((session) => session.agent === agent)?.filePath.replace(/\\/g, '/')
        ).toBe(filePath)
      }
      expect(
        provider.readDirPaths.every((path) => path.replace(/\\/g, '/').startsWith(remoteHome))
      ).toBe(true)
    }
  )
})
