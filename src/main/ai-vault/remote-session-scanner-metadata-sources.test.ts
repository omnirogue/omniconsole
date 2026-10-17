import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as localTranscriptFs from '../native-chat/wsl-transcript-fs-access'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { remoteGrokSource, remoteRovoSource } from './remote-session-scanner-metadata-sources'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import type { RemoteScannerContext } from './remote-session-scanner-types'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'

const kinds = ['grok', 'rovo'] as const
const platforms = [
  { platform: 'darwin-arm64', home: '/Users/Ada', root: '/Users/Ada', os: 'darwin' },
  { platform: 'win32-x64', home: 'C:\\Users\\Ada', root: 'C:/Users/Ada', os: 'win32' }
] as const
const createdAt = '2026-09-12T10:00:00.000Z'
const updatedAt = '2026-09-12T10:05:00.000Z'

function fixture(kind: (typeof kinds)[number], target: (typeof platforms)[number] = platforms[0]) {
  const hostPlatform = getRemoteHostPlatform(target.platform)
  const source = (kind === 'grok' ? remoteGrokSource : remoteRovoSource)(target.home, hostPlatform)
  const filename = kind === 'grok' ? 'summary.json' : 'metadata.json'
  const sibling = kind === 'grok' ? 'chat_history.jsonl' : 'session_context.json'
  const sessionDir = `${target.root}/${kind === 'grok' ? '.grok' : '.rovodev'}/sessions/session-1`
  const file = { path: `${sessionDir}/${filename}`, mtimeMs: 1, modifiedAt: updatedAt }
  const historyPath = `${sessionDir}/${sibling}`
  const cwd = target.os === 'win32' ? 'C:/repo/app' : '/repo/app'
  const metadata = JSON.stringify(
    kind === 'grok'
      ? {
          info: { id: 'session-1', cwd },
          generated_title: 'Remote task',
          current_model_id: 'grok-code',
          head_branch: 'feature/remote',
          num_chat_messages: 7,
          created_at: createdAt,
          updated_at: updatedAt
        }
      : { title: 'Remote task', workspace_path: cwd, created_at: createdAt, updated_at: updatedAt }
  )
  const provider = new MemoryRemoteProvider()
  provider.addFile(historyPath, kind === 'grok' ? '' : '{}', 2)
  const readFile = vi.spyOn(provider, 'readFile')
  const context: RemoteScannerContext = {
    provider,
    executionHostId: 'ssh:rented-mac',
    hostPlatform,
    titleCaches: new Map(),
    antigravityWorkspaceResolver: { enrich: async (session) => session }
  }
  return {
    source,
    file,
    filename,
    sibling,
    historyPath,
    metadata,
    cwd,
    provider,
    readFile,
    context
  }
}

beforeEach(() => {
  const refuseLocal = (): never => {
    throw new Error('Remote source attempted a client filesystem read')
  }
  vi.spyOn(localTranscriptFs, 'wslGatedReadFile').mockImplementation(refuseLocal)
  vi.spyOn(localTranscriptFs, 'wslGatedReaddir').mockImplementation(refuseLocal)
  vi.spyOn(localTranscriptFs, 'openTranscriptReadStream').mockImplementation(refuseLocal)
})

afterEach(() => {
  try {
    expect(localTranscriptFs.wslGatedReadFile).not.toHaveBeenCalled()
    expect(localTranscriptFs.wslGatedReaddir).not.toHaveBeenCalled()
    expect(localTranscriptFs.openTranscriptReadStream).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

describe.each(kinds)('remote %s metadata source', (kind) => {
  it.each(platforms)('uses the owning $os root, paths, and session identity', async (target) => {
    const f = fixture(kind, target)
    expect(f.source.agent).toBe(kind)
    expect(f.source.rootDir).toBe(
      `${target.root}/${kind === 'grok' ? '.grok' : '.rovodev'}/sessions`
    )
    expect(f.source.extensions).toEqual(['.json'])
    expect(f.source.filePredicate?.(f.file.path)).toBe(true)
    expect(f.source.filePredicate?.(`${f.file.path}.bak`)).toBe(false)
    expect(f.source.filePredicate?.(`${f.source.rootDir}/other-${f.filename}`)).toBe(false)
    expect(f.source.filePredicate?.(f.historyPath)).toBe(false)
    expect(f.source.contentDependencyPath?.(f.file.path)).toBe(f.historyPath)
    if (target.os === 'win32') {
      const windowsPath = f.file.path.replaceAll('/', '\\')
      expect(f.source.filePredicate?.(windowsPath)).toBe(true)
      expect(f.source.contentDependencyPath?.(windowsPath)).toBe(f.historyPath)
    }

    const session = await f.source.parse(f.file, f.metadata, f.context)

    expect(session).toMatchObject({
      agent: kind,
      sessionId: 'session-1',
      title: 'Remote task',
      cwd: f.cwd,
      executionHostId: 'ssh:rented-mac',
      executionHostPlatform: target.os,
      filePath: f.file.path,
      createdAt,
      updatedAt,
      previewMessages: []
    })
    expect(f.readFile.mock.calls).toEqual([[f.historyPath]])
    const otherHost = await f.source.parse(f.file, f.metadata, {
      ...f.context,
      executionHostId: 'ssh:another-rented-mac'
    })
    expect(otherHost?.id).not.toBe(session?.id)
    expect(otherHost?.executionHostId).toBe('ssh:another-rented-mac')
  })

  it.each(platforms)('reads an explicit $os storage root through the provider', async (target) => {
    const f = fixture(kind, target)
    const configuredRoot = `${target.root}/account-history`
    const source = (kind === 'grok' ? remoteGrokSource : remoteRovoSource)(
      target.home,
      f.context.hostPlatform,
      configuredRoot
    )
    const expectedRoot = kind === 'grok' ? `${configuredRoot}/sessions` : configuredRoot
    const file = { ...f.file, path: `${expectedRoot}/session-1/${f.filename}` }
    const historyPath = `${expectedRoot}/session-1/${f.sibling}`
    f.provider.addFile(historyPath, kind === 'grok' ? '' : '{}', 2)

    expect(source.rootDir).toBe(expectedRoot)
    expect(source.contentDependencyPath?.(file.path)).toBe(historyPath)
    await expect(source.parse(file, f.metadata, f.context)).resolves.toMatchObject({
      title: 'Remote task',
      sessionId: 'session-1',
      filePath: file.path,
      executionHostId: 'ssh:rented-mac'
    })
    expect(f.readFile.mock.calls).toEqual([[historyPath]])
  })

  it.each([
    { code: 'ENOENT', structured: true },
    { code: 'ENOTDIR', structured: true },
    { code: 'ENOENT', structured: false },
    { code: 'ENOTDIR', structured: false }
  ])('keeps metadata for missing history ($code, code field $structured)', async (failure) => {
    const f = fixture(kind)
    const error = failure.structured
      ? Object.assign(new Error('Missing history'), { code: failure.code })
      : new Error(`Remote read: ${failure.code}: ${f.historyPath}`)
    f.readFile.mockRejectedValue(error)

    await expect(f.source.parse(f.file, f.metadata, f.context)).resolves.toMatchObject({
      agent: kind,
      title: 'Remote task',
      cwd: f.cwd,
      previewMessages: [],
      executionHostId: 'ssh:rented-mac'
    })
  })

  it.each(['EACCES', 'Connection closed'])(
    'propagates %s from the owning provider',
    async (text) => {
      const f = fixture(kind)
      const error = new Error(`${text}: ${f.historyPath}`)
      f.readFile.mockRejectedValue(error)

      await expect(f.source.parse(f.file, f.metadata, f.context)).rejects.toBe(error)
    }
  )

  it('rejects malformed metadata instead of producing a cached partial session', async () => {
    const f = fixture(kind)
    await expect(f.source.parse(f.file, '{broken', f.context)).rejects.toBeInstanceOf(SyntaxError)
  })

  it('rejects a binary sibling instead of treating it as missing', async () => {
    const f = fixture(kind)
    f.readFile.mockResolvedValue({ content: '\u0000binary', isBinary: true })

    await expect(f.source.parse(f.file, f.metadata, f.context)).rejects.toThrow(/binary/i)
  })

  it('honors cancellation before any remote read', async () => {
    const f = fixture(kind)
    const controller = new AbortController()
    controller.abort()

    await expect(
      f.source.parse(f.file, f.metadata, { ...f.context, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.readFile).not.toHaveBeenCalled()
  })

  it.each(['success', 'missing', 'disconnected'])(
    'honors cancellation after a %s read',
    async (outcome) => {
      const f = fixture(kind)
      const controller = new AbortController()
      f.readFile.mockImplementation(async () => {
        controller.abort()
        if (outcome !== 'success') {
          throw new Error(outcome === 'missing' ? 'ENOENT: history' : 'Connection closed')
        }
        return { content: kind === 'grok' ? '' : '{}', isBinary: false }
      })

      await expect(
        f.source.parse(f.file, f.metadata, { ...f.context, signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(f.readFile).toHaveBeenCalledOnce()
    }
  )
})

describe('remote Grok history', () => {
  it('preserves summary metadata and strips injected query envelopes from user text', async () => {
    const f = fixture('grok')
    const ask = 'Review the remote worktree'
    f.provider.addFile(
      f.historyPath,
      jsonLines([
        { type: 'user', content: '<user_info>Bootstrap only</user_info>' },
        {
          type: 'user',
          content: [
            {
              type: 'text',
              text: `<user_info>Private context</user_info><user_query>${ask}</user_query>`
            }
          ],
          timestamp: createdAt
        },
        {
          type: 'assistant',
          content: [{ type: 'text', text: 'Review complete' }],
          timestamp: updatedAt
        }
      ]),
      2
    )

    const session = await withFullFirstUserPromptCapture(() =>
      f.source.parse(f.file, f.metadata, f.context)
    )

    expect(session).toMatchObject({
      title: 'Remote task',
      model: 'grok-code',
      branch: 'feature/remote',
      messageCount: 7,
      firstUserPrompt: ask,
      previewMessages: [
        { role: 'user', text: ask, timestamp: createdAt },
        { role: 'assistant', text: 'Review complete', timestamp: updatedAt }
      ]
    })
    expect(f.readFile.mock.calls).toEqual([[f.historyPath]])
  })

  it('skips corrupt JSONL records while retaining subsequent messages and a prompt title', async () => {
    const f = fixture('grok')
    f.provider.addFile(
      f.historyPath,
      [
        '{broken',
        'null',
        '',
        jsonLines([{ type: 'user', content: '<user_query>Fix the bug</user_query>' }])
      ].join('\n'),
      2
    )

    const session = await f.source.parse(
      f.file,
      JSON.stringify({ info: { cwd: '/repo' } }),
      f.context
    )

    expect(session).toMatchObject({
      sessionId: 'session-1',
      title: 'Fix the bug',
      previewMessages: [{ role: 'user', text: 'Fix the bug', timestamp: null }]
    })
  })
})

describe('remote Rovo history', () => {
  it('reads messages and message_history while excluding tool and system parts', async () => {
    const f = fixture('rovo')
    f.provider.addFile(
      f.historyPath,
      JSON.stringify({
        messages: [
          { role: 'system', content: 'Injected context' },
          { role: 'user', content: 'Improve this workflow', timestamp: createdAt },
          { role: 'assistant', content: 'Working on it', timestamp: createdAt }
        ],
        message_history: [
          { kind: 'request', parts: [{ part_kind: 'tool-return', content: 'Tool output' }] },
          {
            kind: 'request',
            timestamp: updatedAt,
            parts: [{ part_kind: 'user-prompt', content: 'Then review it' }]
          },
          {
            kind: 'response',
            timestamp: updatedAt,
            parts: [
              { part_kind: 'tool-call', content: 'Internal command' },
              { part_kind: 'text', content: 'Review complete' }
            ]
          }
        ]
      }),
      2
    )

    const session = await withFullFirstUserPromptCapture(() =>
      f.source.parse(f.file, f.metadata, f.context)
    )

    expect(session).toMatchObject({
      title: 'Remote task',
      messageCount: 4,
      firstUserPrompt: 'Improve this workflow',
      previewMessages: [
        { role: 'user', text: 'Improve this workflow', timestamp: createdAt },
        { role: 'assistant', text: 'Working on it', timestamp: createdAt },
        { role: 'user', text: 'Then review it', timestamp: updatedAt },
        { role: 'assistant', text: 'Review complete', timestamp: updatedAt }
      ]
    })
  })

  it('propagates malformed context JSON', async () => {
    const f = fixture('rovo')
    f.provider.addFile(f.historyPath, '{"messages":[', 2)

    await expect(f.source.parse(f.file, f.metadata, f.context)).rejects.toBeInstanceOf(SyntaxError)
  })

  it.each(['null', '[]', '42'])('rejects a non-object context document: %s', async (content) => {
    const f = fixture('rovo')
    f.provider.addFile(f.historyPath, content, 2)

    await expect(f.source.parse(f.file, f.metadata, f.context)).rejects.toThrow(/JSON object/)
  })
})
