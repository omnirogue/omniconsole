import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from './transcript-tail-reader'

const mocks = vi.hoisted(() => ({
  requireSshFilesystemProvider: vi.fn(),
  getSshProviderAuthority: vi.fn(),
  isCurrentSshProviderAuthority: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: mocks.requireSshFilesystemProvider
}))
vi.mock('../ssh/ssh-provider-authority', () => ({
  getSshProviderAuthority: mocks.getSshProviderAuthority,
  isCurrentSshProviderAuthority: mocks.isCurrentSshProviderAuthority
}))

const { readNativeChatTranscriptPage } = await import('./transcript-page-reader')
type TranscriptPage = Extract<NativeChatTranscriptPageResult, { complete: boolean }>
const tempRoots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSshFilesystemProvider.mockImplementation(() => {
    throw new Error('SSH provider unavailable')
  })
  mocks.getSshProviderAuthority.mockReturnValue({ providerEpoch: 'remote-epoch-1' })
  mocks.isCurrentSshProviderAuthority.mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
  content: string,
  filename = 'rollout.jsonl'
): Promise<NativeChatTranscriptPageArgs> {
  const root = await mkdtemp(join(tmpdir(), 'omni-transcript-page-'))
  tempRoots.push(root)
  const transcriptPath = join(root, filename)
  await mkdir(dirname(transcriptPath), { recursive: true })
  await writeFile(transcriptPath, content)
  return { agent: 'codex', sessionId: 'session-1', transcriptPath }
}

function eventLine(text: string, role: 'user' | 'assistant' = 'user'): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text }
  })
}

function largeGeminiDocument(): { document: string; content: string } {
  const prefix = '{"messages":[{"type":"user","content":"'
  const content = `${'x'.repeat(
    MAX_FILE_RANGE_READ_BYTES - Buffer.byteLength(prefix) - 1
  )}🚀${'漢🚀'.repeat(300_000)}`
  return { document: `${prefix}${content}"}]}\n`, content }
}

function success(result: NativeChatTranscriptPageResult): TranscriptPage {
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result
}

async function readPages(args: NativeChatTranscriptPageArgs): Promise<TranscriptPage[]> {
  const pages: TranscriptPage[] = []
  for (let index = 0; index < 20; index++) {
    const page = success(await readNativeChatTranscriptPage(args))
    pages.push(page)
    if (page.complete) {
      return pages
    }
    expect(page.cursor).toBeDefined()
    args = { ...args, cursor: page.cursor }
  }
  throw new Error('Transcript pagination did not reach its snapshot fence')
}

describe('readNativeChatTranscriptPage', () => {
  it('paginates the full history with a default 200-record page', async () => {
    const lines = Array.from({ length: 205 }, (_, index) => eventLine(`Turn ${index}`))
    const args = await fixture(`${lines.join('\n')}\n`)
    const pages = await readPages(args)

    expect(pages.map((page) => page.sourceRecords.length)).toEqual([200, 5])
    expect(pages.flatMap((page) => page.sourceRecords.map((record) => record.text))).toEqual(lines)
    expect(pages.flatMap((page) => page.messages)).toHaveLength(205)
    expect(pages[0]).toMatchObject({ complete: false, source: { connectionId: null } })
    expect(pages.at(-1)).toMatchObject({ complete: true })
  })

  it('counts metadata toward the page limit and preserves UTF-8 byte offsets', async () => {
    const metadata = '  {"type":"session_meta","payload":{"id":"session-1","cwd":"/東京/🚀"}}  '
    const prompt = eventLine('Fix café 🚀\n  preserve indentation')
    const answer = eventLine('完了', 'assistant')
    const args = await fixture(`${metadata}\n${prompt}\n${answer}`)
    const pages = await readPages({ ...args, limit: 1 })

    expect(pages).toHaveLength(3)
    expect(pages[0].messages).toEqual([])
    expect(pages.flatMap((page) => page.sourceRecords)).toEqual([
      { byteOffset: 0, text: metadata },
      { byteOffset: Buffer.byteLength(`${metadata}\n`), text: prompt },
      { byteOffset: Buffer.byteLength(`${metadata}\n${prompt}\n`), text: answer }
    ])
    expect(pages[0].cursor?.byteOffset).toBe(Buffer.byteLength(`${metadata}\n`))
    expect(pages.flatMap((page) => page.messages).map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ])
  })

  it('preserves long raw content and model-only or attachment records the display decoder omits', async () => {
    const longText = `  ${'東京🚀 context\n'.repeat(18000)}  `
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: longText }]
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }]
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [{ type: 'resource', resource: { uri: 'artifact://result', text: longText } }]
        }
      })
    ]
    expect(Buffer.byteLength(lines[0])).toBeGreaterThan(64 * 1024)
    const pages = await readPages(await fixture(`${lines.join('\n')}\n`))

    expect(pages.flatMap((page) => page.sourceRecords.map((record) => record.text))).toEqual(lines)
    expect(pages.every((page) => page.truncatedRecordCount === 0)).toBe(true)
  })

  it('reports malformed complete lines and incomplete trailing records separately', async () => {
    const first = eventLine('Before corrupt record')
    const last = eventLine('After corrupt record', 'assistant')
    const broken = '{"type":invalid}'
    const partial = '{"type":"event_msg","payload":'
    const args = await fixture(`${first}\n${broken}\n${last}\n${partial}`)
    const pages = await readPages(args)

    expect(pages.flatMap((page) => page.sourceRecords)).toEqual([
      { byteOffset: 0, text: first },
      { byteOffset: Buffer.byteLength(`${first}\n${broken}\n`), text: last }
    ])
    expect(pages.reduce((count, page) => count + page.malformedRecordCount, 0)).toBe(1)
    expect(pages.reduce((count, page) => count + page.truncatedRecordCount, 0)).toBe(1)
    expect(pages.reduce((count, page) => count + page.oversizedRecordCount, 0)).toBe(0)
    expect(pages.some((page) => page.coverage.rawRecords === 'partial')).toBe(true)
  })

  it('counts an oversized record once and resumes at the next complete record', async () => {
    const first = eventLine('Before oversized record')
    const oversized = eventLine('x'.repeat(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES + 1))
    const last = eventLine('After oversized record', 'assistant')
    const args = await fixture(`${first}\n${oversized}\n${last}\n`)
    const pages = await readPages({ ...args, limit: 1 })

    expect(pages.flatMap((page) => page.sourceRecords)).toEqual([
      { byteOffset: 0, text: first },
      { byteOffset: Buffer.byteLength(`${first}\n${oversized}\n`), text: last }
    ])
    expect(pages.reduce((count, page) => count + page.oversizedRecordCount, 0)).toBe(1)
    expect(pages.reduce((count, page) => count + page.malformedRecordCount, 0)).toBe(0)
    expect(pages.reduce((count, page) => count + page.truncatedRecordCount, 0)).toBe(0)
  })

  it('keeps the original snapshot fence when the live transcript grows between pages', async () => {
    const first = eventLine('Captured first turn')
    const second = eventLine('Captured second turn', 'assistant')
    const appended = eventLine('New turn after capture began')
    const args = await fixture(`${first}\n${second}\n`)
    const page = success(await readNativeChatTranscriptPage({ ...args, limit: 1 }))
    expect(page.cursor).toBeDefined()
    await appendFile(args.transcriptPath!, `${appended}\n`)

    const rest = await readPages({ ...args, limit: 1, cursor: page.cursor })
    expect(rest.flatMap((next) => next.sourceRecords.map((record) => record.text))).toEqual([
      second
    ])
    const fresh = await readPages(args)
    expect(fresh.flatMap((next) => next.sourceRecords.map((record) => record.text))).toEqual([
      first,
      second,
      appended
    ])
  })

  it('returns a complete empty snapshot for an empty transcript', async () => {
    const page = success(await readNativeChatTranscriptPage(await fixture('')))
    expect(page).toMatchObject({
      messages: [],
      sourceRecords: [],
      complete: true,
      malformedRecordCount: 0,
      oversizedRecordCount: 0,
      truncatedRecordCount: 0
    })
  })

  it('captures authoritative JSONL for providers without native display decoders', async () => {
    const lines = [
      '  {"type":"session.start","data":{"sessionId":"session-1"}}  ',
      JSON.stringify({ type: 'user.message', data: { content: 'Review 東京 🚀\n  precisely' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'Full reply' } })
    ]
    const args = await fixture(`${lines.join('\n')}\n`)
    const pages = await readPages({ ...args, agent: 'copilot', limit: 1 })

    expect(pages).toHaveLength(3)
    expect(pages.flatMap((page) => page.sourceRecords.map((record) => record.text))).toEqual(lines)
    expect(pages.flatMap((page) => page.messages)).toEqual([])
    expect(pages.every((page) => page.coverage.projection === 'raw-only')).toBe(true)
    expect(pages.every((page) => page.coverage.rawRecords === 'complete')).toBe(true)
  })

  it('preserves a pretty-printed Gemini JSON conversation as one exact source record', async () => {
    const document = `${JSON.stringify(
      {
        sessionId: 'session-1',
        messages: [
          { type: 'user', content: 'Explain 東京 🚀\n  preserve indentation' },
          { type: 'gemini', content: 'The full answer', thoughts: [{ text: 'Saved note' }] }
        ]
      },
      null,
      2
    )}\n`
    const args = await fixture(document, 'session.json')
    const page = success(await readNativeChatTranscriptPage({ ...args, agent: 'gemini' }))

    expect(page).toMatchObject({
      messages: [],
      sourceRecords: [{ byteOffset: 0, text: document }],
      complete: true,
      malformedRecordCount: 0,
      oversizedRecordCount: 0,
      truncatedRecordCount: 0,
      coverage: {
        format: 'json',
        projection: 'raw-only',
        fromByteOffset: 0,
        toByteOffset: Buffer.byteLength(document),
        snapshotBytes: Buffer.byteLength(document),
        rawRecords: 'complete'
      }
    })
    expect(page.cursor).toBeUndefined()
  })

  it('captures a Gemini document larger than 2 MiB across UTF-8 pages without losing records', async () => {
    const { document, content } = largeGeminiDocument()
    expect(Buffer.byteLength(document)).toBeGreaterThan(2 * 1024 * 1024)
    const args = await fixture(document, 'session.json')
    const pages = await readPages({ ...args, agent: 'gemini' })
    const records = pages.flatMap((page) => page.sourceRecords)
    const reconstructed = records.map((record) => record.text).join('')

    expect(pages.length).toBeGreaterThan(2)
    expect(pages[0].cursor?.byteOffset).toBe(MAX_FILE_RANGE_READ_BYTES - 1)
    expect(records[1].text.startsWith('🚀')).toBe(true)
    expect(reconstructed).toBe(document)
    expect(JSON.parse(reconstructed).messages).toEqual([{ type: 'user', content }])
    let byteOffset = 0
    for (const page of pages) {
      expect(page.sourceRecords).toHaveLength(1)
      expect(page.sourceRecords[0].byteOffset).toBe(byteOffset)
      expect(page.coverage.fromByteOffset).toBe(byteOffset)
      byteOffset += Buffer.byteLength(page.sourceRecords[0].text)
      expect(page.coverage).toMatchObject({
        format: 'json',
        projection: 'raw-only',
        rawRecords: 'complete',
        toByteOffset: byteOffset,
        snapshotBytes: Buffer.byteLength(document)
      })
      expect([
        page.malformedRecordCount,
        page.oversizedRecordCount,
        page.truncatedRecordCount
      ]).toEqual([0, 0, 0])
    }
    expect(byteOffset).toBe(Buffer.byteLength(document))
  })

  it.each(['rewrite', 'append'] as const)(
    'refuses a %s mutation of a Gemini document between pages',
    async (mutation) => {
      const { document } = largeGeminiDocument()
      const args = { ...(await fixture(document, 'session.json')), agent: 'gemini' as const }
      const page = success(await readNativeChatTranscriptPage(args))
      expect(page.complete).toBe(false)
      expect(page.cursor).toBeDefined()
      const before = await stat(args.transcriptPath!)
      await (mutation === 'rewrite'
        ? writeFile(args.transcriptPath!, document.replace('user', 'tool'))
        : appendFile(args.transcriptPath!, '\n '))
      await utimes(args.transcriptPath!, before.atime, new Date(before.mtimeMs + 60_000))

      const result = await readNativeChatTranscriptPage({ ...args, cursor: page.cursor })
      expect(result).toMatchObject({ error: expect.stringContaining('Transcript source changed') })
      expect('sourceRecords' in result).toBe(false)
    }
  )

  it.each(['{"messages": [', '{"sessionId":"session-1","messages":null}'])(
    'returns an explicit error for an incomplete Gemini JSON document: %s',
    async (document) => {
      const args = await fixture(document, 'session.json')
      const result = await readNativeChatTranscriptPage({ ...args, agent: 'gemini' })

      expect(result).toMatchObject({
        source: { connectionId: null },
        error: expect.stringMatching(/.+/)
      })
      expect('sourceRecords' in result).toBe(false)
      expect('complete' in result).toBe(false)
    }
  )

  it.each([
    { filename: join('session-1', 'state.json'), error: 'no authoritative agent map' },
    { filename: 'state.json', error: 'different source session' }
  ])(
    'refuses invalid Kimi metadata or a mismatched state path: $error',
    async ({ filename, error }) => {
      const args = await fixture('{"title":"Review","lastPrompt":"Check the patch"}', filename)
      const result = await readNativeChatTranscriptPage({ ...args, agent: 'kimi' })

      expect(result).toMatchObject({ error: expect.stringContaining(error) })
      expect('sourceRecords' in result).toBe(false)
      expect('complete' in result).toBe(false)
    }
  )

  it('resolves Kimi state.json to its primary wire transcript across all capture pages', async () => {
    const state = JSON.stringify({
      id: 'session-1',
      agents: {
        worker: { type: 'sub', parentAgentId: 'main' },
        main: { type: 'main', parentAgentId: null, homedir: '/other-host/copied-agent' }
      }
    })
    const args = await fixture(state, join('session-1', 'state.json'))
    const wirePath = join(dirname(args.transcriptPath!), 'agents', 'main', 'wire.jsonl')
    const lines = Array.from({ length: 3 }, (_, turn) => [
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          origin: { kind: 'user' },
          content: [
            { type: 'text', text: `Prompt ${turn}: 東京 🚀` },
            { type: 'image', source: { type: 'blob', id: `attachment-${turn}` } }
          ]
        }
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: `Reply ${turn} ` }
        }
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: 'continues\n  with indentation' }
        }
      },
      { type: 'context.append_loop_event', event: { type: 'step.end' } }
    ])
      .flat()
      .map((record) => JSON.stringify(record))
    await mkdir(dirname(wirePath), { recursive: true })
    await writeFile(wirePath, `${lines.join('\n')}\n`)
    const pages = await readPages({ ...args, agent: 'kimi', limit: 2 })

    expect(pages).toHaveLength(6)
    expect(pages.flatMap((page) => page.sourceRecords.map((record) => record.text))).toEqual(lines)
    expect(pages.flatMap((page) => page.messages)).toEqual([])
    for (const page of pages.slice(0, -1)) {
      expect(page.cursor).toMatchObject({
        agent: 'kimi',
        sessionId: 'session-1',
        filePath: wirePath,
        originPath: args.transcriptPath
      })
      expect(page.coverage).toMatchObject({
        format: 'jsonl',
        projection: 'raw-only',
        rawRecords: 'complete'
      })
    }
  })

  it('refuses continuation after an overwrite preserves the source inode and byte size', async () => {
    const original = `${eventLine('Original A')}\n${eventLine('Original B')}\n`
    const args = await fixture(original)
    const page = success(await readNativeChatTranscriptPage({ ...args, limit: 1 }))
    const before = await stat(args.transcriptPath!)
    expect(page.cursor).toMatchObject({ observedSize: before.size, observedMtime: before.mtimeMs })
    await writeFile(args.transcriptPath!, original.replaceAll('Original', 'Modified'))
    await utimes(args.transcriptPath!, before.atime, new Date(before.mtimeMs + 60_000))
    const after = await stat(args.transcriptPath!)
    expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      size: before.size
    })
    expect(after.mtimeMs).not.toBe(before.mtimeMs)

    const result = await readNativeChatTranscriptPage({ ...args, cursor: page.cursor })
    expect(result).toMatchObject({ error: expect.stringContaining('Transcript source changed') })
    expect('sourceRecords' in result).toBe(false)
  })

  it.each([{ connectionId: 'different-host' }, { sessionId: 'different-session' }])(
    'refuses a continuation cursor rebound to another source: %j',
    async (changedSource) => {
      const args = await fixture(`${eventLine('First')}\n${eventLine('Second')}\n`)
      const page = success(await readNativeChatTranscriptPage({ ...args, limit: 1 }))
      expect(page.cursor).toBeDefined()

      const result = await readNativeChatTranscriptPage({
        ...args,
        ...changedSource,
        cursor: page.cursor
      })
      expect(result).toMatchObject({ error: expect.stringContaining('different source session') })
      expect('sourceRecords' in result).toBe(false)
      expect(mocks.requireSshFilesystemProvider).not.toHaveBeenCalled()
    }
  )

  it('never reads a same-path local transcript when its remote provider is missing', async () => {
    const args = await fixture(`${eventLine('Local content must not cross hosts')}\n`)
    const result = await readNativeChatTranscriptPage({ ...args, connectionId: 'rented-mac' })

    expect(result).toMatchObject({
      source: { connectionId: 'rented-mac' },
      error: expect.stringContaining('SSH provider unavailable')
    })
    expect('sourceRecords' in result).toBe(false)
    expect(mocks.requireSshFilesystemProvider).toHaveBeenCalledWith('rented-mac')
  })

  it('reads transcript bytes exclusively from the selected remote host', async () => {
    const remoteLine = eventLine('Captured from the rented Mac 🚀', 'assistant')
    const bytes = Buffer.from(`${remoteLine}\n`)
    const readFileRange = vi.fn(async (_path: string, position: number, length: number) => ({
      bytes: bytes.subarray(position, position + length)
    }))
    mocks.requireSshFilesystemProvider.mockReturnValue({
      supportsFileRangeRead: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue({ type: 'file', size: bytes.length, dev: 1, ino: 99 }),
      readFileRange
    })
    const args = await fixture(`${eventLine('Local same-path transcript')}\n`)
    const page = success(
      await readNativeChatTranscriptPage({ ...args, connectionId: 'rented-mac' })
    )

    expect(page).toMatchObject({
      source: { connectionId: 'rented-mac' },
      sourceRecords: [{ byteOffset: 0, text: remoteLine }],
      complete: true,
      coverage: { snapshotBytes: bytes.length, rawRecords: 'complete' }
    })
    expect(page.messages[0].blocks).toEqual([
      { type: 'text', text: 'Captured from the rented Mac 🚀' }
    ])
    expect(readFileRange).toHaveBeenCalledWith(args.transcriptPath, 0, bytes.length, {
      signal: undefined
    })
  })

  it('resolves a missing transcript path on SSH and reads only that host path across pages', async () => {
    const remotePath = '/rented/home/.copilot/sessions/session-1/events.jsonl'
    const lines = [
      JSON.stringify({ type: 'session.start', data: { sessionId: 'session-1' } }),
      JSON.stringify({ type: 'user.message', data: { content: 'Remote-only prompt 🚀' } })
    ]
    const bytes = Buffer.from(`${lines.join('\n')}\n`)
    const resolveSource = vi.fn().mockResolvedValue(remotePath)
    const remoteStat = vi.fn().mockResolvedValue({
      type: 'file',
      size: bytes.length,
      dev: 10,
      ino: 100,
      mtimeMs: 1_000
    })
    const readFileRange = vi.fn(async (_path: string, position: number, length: number) => ({
      bytes: bytes.subarray(position, position + length)
    }))
    mocks.requireSshFilesystemProvider.mockReturnValue({
      transcripts: { resolveSource },
      supportsFileRangeRead: vi.fn().mockResolvedValue(true),
      stat: remoteStat,
      readFileRange
    })
    const local = await fixture(`${eventLine('Local history must stay local')}\n`)
    const localResolver = vi
      .spyOn(await import('./session-file-resolver'), 'resolveSessionFilePath')
      .mockResolvedValue(local.transcriptPath!)
    const pages = await readPages({
      agent: 'copilot',
      sessionId: 'session-1',
      connectionId: 'rented-mac',
      limit: 1
    })

    expect(resolveSource).toHaveBeenCalledExactlyOnceWith('copilot', 'session-1', undefined)
    expect(localResolver).not.toHaveBeenCalled()
    expect(pages).toHaveLength(2)
    expect(pages[0].cursor).toMatchObject({ filePath: remotePath, connectionId: 'rented-mac' })
    expect(pages.flatMap((page) => page.sourceRecords.map((record) => record.text))).toEqual(lines)
    expect(pages.every((page) => page.source.connectionId === 'rented-mac')).toBe(true)
    expect(new Set(remoteStat.mock.calls.map(([path]) => path))).toEqual(new Set([remotePath]))
    expect(new Set(readFileRange.mock.calls.map(([path]) => path))).toEqual(new Set([remotePath]))
  })

  it.each(['missing-capability', 'not-found', 'unavailable'] as const)(
    'does not fall back to local discovery when SSH source lookup is %s',
    async (lookupState) => {
      const resolveSource = vi.fn().mockResolvedValue(null)
      if (lookupState === 'unavailable') {
        resolveSource.mockRejectedValue(new Error('Owning host transcript index is unavailable'))
      }
      const remoteStat = vi.fn()
      const readFileRange = vi.fn()
      mocks.requireSshFilesystemProvider.mockReturnValue({
        ...(lookupState === 'missing-capability' ? {} : { transcripts: { resolveSource } }),
        supportsFileRangeRead: vi.fn().mockResolvedValue(true),
        stat: remoteStat,
        readFileRange
      })
      const local = await fixture(`${eventLine('Local fallback would expose the wrong history')}\n`)
      const localResolver = vi
        .spyOn(await import('./session-file-resolver'), 'resolveSessionFilePath')
        .mockResolvedValue(local.transcriptPath!)
      const result = await readNativeChatTranscriptPage({
        agent: 'copilot',
        sessionId: 'session-1',
        connectionId: 'rented-mac'
      })

      expect(result).toMatchObject({
        source: { connectionId: 'rented-mac' },
        error: expect.stringMatching(/.+/)
      })
      if (lookupState === 'not-found') {
        expect(result).toMatchObject({ notFound: true })
      }
      expect('sourceRecords' in result).toBe(false)
      expect(localResolver).not.toHaveBeenCalled()
      expect(remoteStat).not.toHaveBeenCalled()
      expect(readFileRange).not.toHaveBeenCalled()
    }
  )

  it('refuses an old remote relay without falling back to the readable local path', async () => {
    const readFileRange = vi.fn()
    const stat = vi.fn()
    mocks.requireSshFilesystemProvider.mockReturnValue({
      readFileRange,
      stat,
      supportsFileRangeRead: vi.fn().mockResolvedValue(false)
    })
    const args = await fixture(`${eventLine('Wrong-host content')}\n`)
    const result = await readNativeChatTranscriptPage({ ...args, connectionId: 'old-relay' })

    expect(result).toMatchObject({
      source: { connectionId: 'old-relay' },
      error: expect.stringContaining('Update the SSH relay')
    })
    expect('sourceRecords' in result).toBe(false)
    expect(readFileRange).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
})
