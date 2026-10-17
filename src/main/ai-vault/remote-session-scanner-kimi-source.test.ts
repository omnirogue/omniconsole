import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import * as localTranscriptFs from '../native-chat/wsl-transcript-fs-access'
import { discoverRemoteSourceCandidates } from './remote-session-scanner-discovery'
import { remoteKimiSource } from './remote-session-scanner-kimi-source'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import type { RemoteScannerContext } from './remote-session-scanner-types'
import type { FileWithMtime } from './session-scanner-types'

const SESSION_ID = 'session_4243babe-c33c-4ca3-8245-689c9e34ba3b'
const WIRE_RECORDS = [
  { type: 'config.update', modelAlias: 'kimi-config' },
  {
    type: 'context.append_message',
    message: { role: 'user', content: 'Review the remote project', origin: { kind: 'user' } }
  },
  {
    type: 'context.append_message',
    message: { role: 'user', content: 'Synthetic reminder', origin: { kind: 'injection' } }
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'content.part', part: { type: 'text', text: 'First ' } }
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'content.part', part: { type: 'text', text: 'response' } }
  },
  { type: 'context.append_loop_event', event: { type: 'step.end' } },
  {
    type: 'usage.record',
    model: 'kimi-wire',
    usage: { inputOther: 12, output: 18, inputCacheRead: 3, inputCacheCreation: 7 },
    usageScope: 'turn'
  },
  { type: 'usage.record', usage: { output: 999 }, usageScope: 'session' }
]

function fixture(home = '/home/ada', windows = false) {
  const provider = new MemoryRemoteProvider()
  const hostPlatform = getRemoteHostPlatform(windows ? 'win32-x64' : 'linux-x64')
  const source = remoteKimiSource(home, hostPlatform)
  const sessionDir = `${home}/.kimi-code/sessions/wd_remote_1234/${SESSION_ID}`
  const indexPath = `${home}/.kimi-code/session_index.jsonl`
  const wirePath = `${sessionDir}/agents/root-agent/wire.jsonl`
  const state = {
    title: 'Remote Kimi',
    lastPrompt: 'Review the remote project',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:02:00.000Z',
    agents: {
      'root-agent': { type: 'main', parentAgentId: null, homedir: '/dispatcher/private/agent' },
      child: { type: 'main', parentAgentId: 'root-agent' }
    }
  }
  const file: FileWithMtime = {
    path: `${sessionDir}/state.json`,
    mtimeMs: Date.parse(state.updatedAt),
    modifiedAt: state.updatedAt
  }
  const context: RemoteScannerContext = {
    provider,
    hostPlatform,
    executionHostId: 'ssh:rented-mac',
    titleCaches: new Map(),
    antigravityWorkspaceResolver: { enrich: async (session) => session }
  }
  provider.addFile(file.path, JSON.stringify(state), file.mtimeMs)
  return { provider, source, context, state, file, wirePath, indexPath, sessionDir }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('remoteKimiSource', () => {
  it('indexes host-owned state, primary wire and work directory without any local reads', async () => {
    const f = fixture()
    const localRead = vi.spyOn(localTranscriptFs, 'wslGatedReadFile')
    const localStream = vi.spyOn(localTranscriptFs, 'openTranscriptReadStream')
    const remoteRead = vi.spyOn(f.provider, 'readFile')
    f.provider.addFile(f.wirePath, jsonLines(WIRE_RECORDS), 1)
    f.provider.addFile(
      f.indexPath,
      jsonLines([
        { sessionId: SESSION_ID, workDir: '/remote/old' },
        { sessionId: SESSION_ID, workDir: '/remote/project', sessionDir: '/dispatcher/copied' }
      ]),
      1
    )
    const session = await f.source.parse(f.file, JSON.stringify(f.state), f.context)
    expect(session).toMatchObject({
      agent: 'kimi',
      sessionId: SESSION_ID,
      executionHostId: 'ssh:rented-mac',
      executionHostPlatform: 'linux',
      filePath: f.file.path,
      title: 'Remote Kimi',
      cwd: '/remote/project',
      model: 'kimi-wire',
      totalTokens: 40,
      messageCount: 2,
      createdAt: f.state.createdAt,
      updatedAt: f.state.updatedAt,
      previewMessages: [
        { role: 'user', text: 'Review the remote project', timestamp: null },
        { role: 'assistant', text: 'First response', timestamp: null }
      ],
      resumeCommand: `cd '/remote/project' && kimi --session '${SESSION_ID}'`
    })
    expect(remoteRead.mock.calls.map(([path]) => path)).toEqual([f.wirePath, f.indexPath])
    expect(localRead).not.toHaveBeenCalled()
    expect(localStream).not.toHaveBeenCalled()
  })

  it('discovers only state files in the exact work-directory/session layout', async () => {
    const f = fixture()
    f.provider.addFile(f.wirePath, '{}', 1)
    f.provider.addFile(`${f.sessionDir}/agents/child/state.json`, '{}', 1)
    f.provider.addFile(`${f.sessionDir}/unrelated.json`, '{}', 1)
    f.provider.addFile(`${f.source.rootDir}/other/${SESSION_ID}/state.json`, '{}', 1)
    f.provider.addFile(`${f.source.rootDir}/wd_other/not-a-session/state.json`, '{}', 1)
    const issues: Parameters<typeof discoverRemoteSourceCandidates>[0]['issues'] = []
    const candidates = await discoverRemoteSourceCandidates({
      source: f.source,
      context: f.context,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates.map((candidate) => candidate.file.path)).toEqual([f.file.path])
    expect(f.provider.readDirPaths).not.toContain(`${f.sessionDir}/agents`)
    expect(f.source.filePredicate?.(f.file.path.replace('/.kimi-code/', '/.other/'))).toBe(false)
  })

  it('uses the remote default root regardless of dispatcher KIMI_CODE_HOME', () => {
    vi.stubEnv('KIMI_CODE_HOME', '/dispatcher/private/kimi')
    expect(fixture().source.rootDir).toBe('/home/ada/.kimi-code/sessions')
  })

  it('uses an explicitly provided owning-host Kimi home for sessions and the shared index', async () => {
    const f = fixture()
    const source = remoteKimiSource('/home/ada', f.context.hostPlatform, '/remote/custom-kimi')
    const file = {
      ...f.file,
      path: `/remote/custom-kimi/sessions/wd_remote_1234/${SESSION_ID}/state.json`
    }
    f.provider.addFile(
      '/remote/custom-kimi/session_index.jsonl',
      jsonLines([{ sessionId: SESSION_ID, workDir: '/remote/custom-project' }]),
      1
    )
    expect(source.rootDir).toBe('/remote/custom-kimi/sessions')
    await expect(source.parse(file, JSON.stringify(f.state), f.context)).resolves.toMatchObject({
      cwd: '/remote/custom-project',
      filePath: file.path
    })
  })

  it('supports a Windows owning host and keeps the prefixed session identity', async () => {
    const f = fixture('C:/Users/Ada', true)
    f.provider.addFile(f.wirePath, jsonLines(WIRE_RECORDS), 1)
    f.provider.addFile(
      f.indexPath,
      jsonLines([{ sessionId: SESSION_ID, workDir: 'C:/remote/project' }]),
      1
    )
    expect(f.source.filePredicate?.(f.file.path.replace(/\//g, '\\'))).toBe(true)
    const session = await f.source.parse(f.file, JSON.stringify(f.state), f.context)
    expect(session).toMatchObject({
      executionHostPlatform: 'win32',
      sessionId: SESSION_ID,
      cwd: 'C:/remote/project',
      messageCount: 2,
      resumeCommand: `cmd /d /s /c "cd /d ""C:/remote/project"" && kimi --session ""${SESSION_ID}"""`
    })
  })

  it('retains metadata-only sessions when wire and index do not exist yet', async () => {
    const f = fixture()
    await expect(f.source.parse(f.file, JSON.stringify(f.state), f.context)).resolves.toMatchObject(
      {
        sessionId: SESSION_ID,
        title: 'Remote Kimi',
        messageCount: 0,
        cwd: null,
        model: null
      }
    )
  })

  it('coalesces concurrent index reads while separating owning hosts', async () => {
    const f = fixture()
    const other = fixture()
    other.context.executionHostId = 'ssh:other-host'
    other.context.titleCaches = f.context.titleCaches
    f.provider.addFile(f.indexPath, jsonLines([{ sessionId: SESSION_ID, workDir: '/remote/a' }]), 1)
    other.provider.addFile(
      other.indexPath,
      jsonLines([{ sessionId: SESSION_ID, workDir: '/remote/b' }]),
      1
    )
    const read = vi.spyOn(f.provider, 'readFile')
    const [first, second, third] = await Promise.all([
      f.source.parse(f.file, JSON.stringify(f.state), f.context),
      f.source.parse(f.file, JSON.stringify(f.state), f.context),
      other.source.parse(other.file, JSON.stringify(other.state), other.context)
    ])
    expect([first?.cwd, second?.cwd, third?.cwd]).toEqual(['/remote/a', '/remote/a', '/remote/b'])
    expect(read.mock.calls.filter(([path]) => path === f.indexPath)).toHaveLength(1)
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['non-object metadata', '[]'],
    [
      'ambiguous primary agents',
      JSON.stringify({ agents: { a: { type: 'main' }, b: { type: 'main' } } })
    ],
    ['unsafe agent identity', JSON.stringify({ agents: { '../escape': { type: 'main' } } })],
    [
      'different state identity',
      JSON.stringify({ id: 'session_wrong', agents: { main: { type: 'main' } } })
    ]
  ])('surfaces %s without reading any candidate wire', async (_label, content) => {
    const f = fixture()
    const read = vi.spyOn(f.provider, 'readFile')
    await expect(f.source.parse(f.file, content, f.context)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['wirePath', 'indexPath'] as const)('surfaces %s transport failures', async (target) => {
    const f = fixture()
    const readFile = f.provider.readFile.bind(f.provider)
    vi.spyOn(f.provider, 'readFile').mockImplementation(async (path) => {
      if (path === f[target]) {
        throw new Error('SSH connection unavailable')
      }
      return readFile(path)
    })
    await expect(f.source.parse(f.file, JSON.stringify(f.state), f.context)).rejects.toThrow(
      'SSH connection unavailable'
    )
  })

  it('rejects binary wire data instead of reporting an empty conversation', async () => {
    const f = fixture()
    vi.spyOn(f.provider, 'readFile').mockResolvedValue({ content: '', isBinary: true })
    await expect(f.source.parse(f.file, JSON.stringify(f.state), f.context)).rejects.toThrow(
      'not readable text'
    )
  })

  it('stops when cancelled during a remote read before reading the index', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.context.signal = controller.signal
    const read = vi.spyOn(f.provider, 'readFile').mockImplementation(async () => {
      controller.abort()
      return { content: jsonLines(WIRE_RECORDS), isBinary: false }
    })
    await expect(f.source.parse(f.file, JSON.stringify(f.state), f.context)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not start a remote read for an already cancelled scan', async () => {
    const f = fixture()
    f.context.signal = AbortSignal.abort()
    const read = vi.spyOn(f.provider, 'readFile')
    await expect(f.source.parse(f.file, JSON.stringify(f.state), f.context)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(read).not.toHaveBeenCalled()
  })
})
