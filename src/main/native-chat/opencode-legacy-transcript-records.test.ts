import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readOpenCodeLegacyTranscriptRecords } from './opencode-legacy-transcript-records'
import type { OpenCodeTranscriptRecord } from './opencode-sqlite-transcript-records'

const sessionId = 'ses_exact'
const messageId = 'msg_one'
let base: string
let root: string
let sessionPath: string

async function writeRaw(path: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function writeRecord(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeRaw(path, text)
  return text
}

function messagePath(id = messageId): string {
  return join(root, 'message', sessionId, `${id}.json`)
}

function partPath(id = 'prt_one', parent = messageId): string {
  return join(root, 'part', parent, `${id}.json`)
}

async function collect(
  args: { sessionId: string; transcriptPath?: string } = { sessionId, transcriptPath: sessionPath }
) {
  const records: OpenCodeTranscriptRecord[] = []
  for await (const record of readOpenCodeLegacyTranscriptRecords(args)) {
    records.push(record)
  }
  return records
}

async function writeConversation(): Promise<void> {
  await writeRecord(messagePath(), { id: messageId, sessionID: sessionId, role: 'assistant' })
  await writeRecord(partPath(), {
    id: 'prt_one',
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text: 'Finished.'
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'opencode-legacy-transcript-'))
  vi.stubEnv('XDG_DATA_HOME', join(base, 'xdg'))
  root = join(base, 'custom-storage')
  sessionPath = join(root, 'session', 'project_one', `${sessionId}.json`)
  await writeRecord(sessionPath, { id: sessionId, title: 'Original session' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(base, { recursive: true, force: true })
})

describe('readOpenCodeLegacyTranscriptRecords', () => {
  it('retains exact session, message, tool, nontext and unknown record JSON', async () => {
    const sessionText = await writeRecord(sessionPath, {
      id: sessionId,
      title: 'Complete record',
      futureMetadata: { checkpoint: ['raw', 7] }
    })
    const messageText = await writeRecord(messagePath(), {
      id: messageId,
      sessionID: sessionId,
      role: 'assistant',
      modelID: 'model_one',
      tokens: { output: 12 }
    })
    const values = [
      {
        id: 'prt_1',
        type: 'tool',
        tool: 'bash',
        state: { input: { command: 'pwd' }, output: '/repo' }
      },
      { id: 'prt_2', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==' },
      { id: 'prt_3', type: 'future-event', nested: { raw: [false, null, { value: 'kept' }] } }
    ]
    const partTexts: string[] = []
    for (const value of values) {
      partTexts.push(
        await writeRecord(partPath(value.id), {
          ...value,
          sessionID: sessionId,
          messageID: messageId
        })
      )
    }

    expect(await collect()).toEqual([
      { recordType: 'session', recordId: sessionId, text: sessionText },
      { recordType: 'message', recordId: messageId, text: messageText },
      ...values.map((value, index) => ({
        recordType: 'part',
        recordId: value.id,
        text: partTexts[index]
      }))
    ])
  })

  it('retains more than one MiB of UTF-8 text including multibyte chunk boundaries', async () => {
    await writeRecord(messagePath(), { id: messageId, sessionID: sessionId })
    const text = 'é🌍漢字'.repeat(150_000)
    const raw = await writeRecord(partPath(), {
      id: 'prt_one',
      sessionID: sessionId,
      messageID: messageId,
      type: 'text',
      text
    })
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024)
    const records = await collect()
    expect(records[2].text).toBe(raw)
    expect(JSON.parse(records[2].text).text).toBe(text)
  })

  it('orders messages and their parts by creation time, then ID, with undated records last', async () => {
    for (const [id, created] of [
      ['msg_undated_z', undefined],
      ['msg_later', 20],
      ['msg_b', 10],
      ['msg_a', 10],
      ['msg_undated_a', undefined]
    ] as const) {
      await writeRecord(messagePath(id), { id, sessionID: sessionId, time: { created } })
    }
    for (const [id, created] of [
      ['prt_undated_z', undefined],
      ['prt_later', 20],
      ['prt_b', 10],
      ['prt_a', 10],
      ['prt_undated_a', undefined]
    ] as const) {
      await writeRecord(partPath(id, 'msg_a'), {
        id,
        sessionID: sessionId,
        messageID: 'msg_a',
        time: { created }
      })
    }
    expect((await collect()).map((record) => record.recordId)).toEqual([
      sessionId,
      'msg_a',
      'prt_a',
      'prt_b',
      'prt_later',
      'prt_undated_a',
      'prt_undated_z',
      'msg_b',
      'msg_later',
      'msg_undated_a',
      'msg_undated_z'
    ])
  })

  it('uses the supplied custom storage root even when default storage has the same session ID', async () => {
    const decoyRoot = join(base, 'xdg', 'opencode', 'storage')
    await writeRecord(join(decoyRoot, 'session', 'default_project', `${sessionId}.json`), {
      id: sessionId,
      title: 'Wrong storage root'
    })
    await writeRecord(join(decoyRoot, 'message', sessionId, 'msg_decoy.json'), { id: 'msg_decoy' })
    await writeConversation()
    const records = await collect()
    expect(records.map((record) => record.recordId)).toEqual([sessionId, messageId, 'prt_one'])
    expect(JSON.parse(records[0].text).title).toBe('Original session')
  })

  it('discovers an exact session filename under XDG_DATA_HOME without selecting prefix matches', async () => {
    root = join(base, 'xdg', 'opencode', 'storage')
    sessionPath = join(root, 'session', 'project_two', `${sessionId}.json`)
    await writeRecord(join(root, 'session', 'project_one', `${sessionId}_other.json`), {
      id: `${sessionId}_other`
    })
    await writeRecord(sessionPath, { id: sessionId, title: 'XDG session' })
    await writeConversation()
    const records = await collect({ sessionId, transcriptPath: undefined })
    expect(records.map((record) => record.recordId)).toEqual([sessionId, messageId, 'prt_one'])
    expect(JSON.parse(records[0].text).title).toBe('XDG session')
  })

  it('returns ENOENT when only a fuzzy session match exists', async () => {
    await writeRecord(
      join(base, 'xdg', 'opencode', 'storage', 'session', 'project', `${sessionId}_other.json`),
      {
        id: `${sessionId}_other`
      }
    )
    await expect(collect({ sessionId, transcriptPath: undefined })).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('distinguishes an absent session from an existing session with no messages', async () => {
    const records = await collect()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ recordType: 'session', recordId: sessionId })
    await rm(sessionPath)
    await expect(collect()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the exact filename identity when legacy records omit their ID', async () => {
    await writeRecord(sessionPath, { title: 'ID omitted' })
    await writeRecord(messagePath(), { sessionID: sessionId })
    await writeRecord(partPath(), { sessionID: sessionId, messageID: messageId, text: 'Retained.' })
    expect((await collect()).map((record) => record.recordId)).toEqual([
      sessionId,
      messageId,
      'prt_one'
    ])
  })

  it('refuses ambiguous session IDs across default storage projects', async () => {
    const storage = join(base, 'xdg', 'opencode', 'storage')
    for (const project of ['first', 'second']) {
      await writeRecord(join(storage, 'session', project, `${sessionId}.json`), { id: sessionId })
    }
    await expect(collect({ sessionId, transcriptPath: undefined })).rejects.toThrow('ambiguous')
  })

  it.each([
    ['malformed JSON', '{"id":', 'Corrupt JSON'],
    ['array', '[]', 'must be a JSON object'],
    ['null', 'null', 'must be a JSON object'],
    ['string', '"text"', 'must be a JSON object'],
    ['number', '42', 'must be a JSON object'],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), 'Corrupt UTF-8']
  ] as const)('rejects %s instead of silently losing session data', async (_label, raw, error) => {
    await writeRaw(sessionPath, raw)
    await expect(collect()).rejects.toThrow(error)
  })

  it.each(['message', 'part'])('rejects corruption in a child %s record', async (kind) => {
    await writeConversation()
    await writeRaw(kind === 'message' ? messagePath() : partPath(), '{broken')
    await expect(collect()).rejects.toThrow('Corrupt JSON')
  })

  it.each(['', '..', '../other', 'ses/other', 'ses\\other', 'ses\0other'])(
    'rejects unsafe session ID %j',
    async (id) => {
      await expect(collect({ sessionId: id, transcriptPath: sessionPath })).rejects.toThrow(
        'Invalid OpenCode'
      )
    }
  )

  it.each(['message', 'part'])('rejects traversal IDs embedded in %s JSON', async (kind) => {
    await writeConversation()
    await writeRecord(kind === 'message' ? messagePath() : partPath(), { id: '../outside' })
    await expect(collect()).rejects.toThrow('Invalid OpenCode transcript record ID')
  })

  it.each([null, 42, false])('rejects an explicit non-string record ID %j', async (id) => {
    await writeRecord(sessionPath, { id })
    await expect(collect()).rejects.toThrow('Invalid OpenCode record ID')
  })

  it.each([
    '',
    'relative/session/project/ses_exact.json',
    '/tmp/session/project/../ses_exact.json',
    '/tmp/file\0.json'
  ])('rejects non-authoritative supplied path %j', async (transcriptPath) => {
    await expect(collect({ sessionId, transcriptPath })).rejects.toThrow(
      'must be absolute without traversal'
    )
  })

  it('rejects arbitrary JSON files outside legacy session storage', async () => {
    const transcriptPath = join(base, 'config.json')
    await writeRecord(transcriptPath, { id: sessionId })
    await expect(collect({ sessionId, transcriptPath })).rejects.toThrow('legacy session JSON file')
  })

  it('rejects a supplied session file whose content belongs to another session', async () => {
    await writeRecord(sessionPath, { id: 'ses_other' })
    await expect(collect()).rejects.toThrow('file belongs to a different session')
  })

  it.each([
    ['message session', 'message', { id: messageId, sessionID: 'ses_other' }],
    ['part session', 'part', { id: 'prt_one', sessionID: 'ses_other', messageID: messageId }],
    ['part message', 'part', { id: 'prt_one', sessionID: sessionId, messageID: 'msg_other' }]
  ] as const)('rejects mismatched %s ownership', async (_label, kind, value) => {
    await writeConversation()
    await writeRecord(kind === 'message' ? messagePath() : partPath(), value)
    await expect(collect()).rejects.toThrow('belongs to a different session or message')
  })

  it.each(['message', 'part'])(
    'rejects duplicate %s record IDs across distinct files',
    async (kind) => {
      await writeConversation()
      await writeRecord(
        kind === 'message' ? messagePath('msg_duplicate') : partPath('prt_duplicate'),
        {
          id: kind === 'message' ? messageId : 'prt_one',
          sessionID: sessionId,
          messageID: messageId
        }
      )
      await expect(collect()).rejects.toThrow('Duplicate OpenCode transcript record ID')
    }
  )

  it.skipIf(process.platform === 'win32').each(['session', 'message', 'part'])(
    'rejects a %s JSON symlink instead of following it outside storage',
    async (kind) => {
      await writeConversation()
      const path =
        kind === 'session' ? sessionPath : kind === 'message' ? messagePath() : partPath()
      const target = join(base, 'outside-storage.json')
      await writeRecord(target, {
        id: kind === 'session' ? sessionId : kind === 'message' ? messageId : 'prt_one',
        sessionID: sessionId,
        messageID: messageId
      })
      await rm(path)
      await symlink(target, path, 'file')
      await expect(collect()).rejects.toThrow('not a regular file')
    }
  )

  it.skipIf(process.platform === 'win32').each(['message root', 'session message directory'])(
    'rejects a symlink for the %s',
    async (kind) => {
      await writeConversation()
      const isRoot = kind === 'message root'
      const path = isRoot ? join(root, 'message') : dirname(messagePath())
      const target = join(base, 'outside-message-directory')
      await writeRecord(join(target, ...(isRoot ? [sessionId] : []), `${messageId}.json`), {
        id: messageId,
        sessionID: sessionId
      })
      await rm(path, { recursive: true })
      await symlink(target, path, 'dir')
      await expect(collect()).rejects.toThrow('not a regular directory')
    }
  )

  it('rejects an already-aborted capture before reading any record', async () => {
    const controller = new AbortController()
    const reason = new Error('Capture cancelled before reading')
    controller.abort(reason)
    const iterator = readOpenCodeLegacyTranscriptRecords(
      { sessionId, transcriptPath: sessionPath },
      controller.signal
    )
    await expect(iterator.next()).rejects.toBe(reason)
  })

  it.each([1, 3])('honors cancellation after yielding %i records', async (count) => {
    await writeConversation()
    const controller = new AbortController()
    const iterator = readOpenCodeLegacyTranscriptRecords(
      { sessionId, transcriptPath: sessionPath },
      controller.signal
    )
    for (let index = 0; index < count; index++) {
      expect((await iterator.next()).done).toBe(false)
    }
    const reason = new Error('Capture cancelled while yielding')
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
  })

  it.each(['session', 'message', 'part'])(
    'detects a yielded %s changing before capture completes',
    async (kind) => {
      await writeConversation()
      const iterator = readOpenCodeLegacyTranscriptRecords({
        sessionId,
        transcriptPath: sessionPath
      })
      for (let index = 0; index < 3; index++) {
        expect((await iterator.next()).done).toBe(false)
      }
      const path =
        kind === 'session' ? sessionPath : kind === 'message' ? messagePath() : partPath()
      await writeRecord(path, {
        id: 'changed_record',
        text: 'The source changed after this record was yielded.'
      })
      await expect(iterator.next()).rejects.toThrow('source changed while reading')
    }
  )

  it('reports a session deleted after its yield as a changed capture rather than an absent session', async () => {
    const iterator = readOpenCodeLegacyTranscriptRecords({ sessionId, transcriptPath: sessionPath })
    expect((await iterator.next()).value).toMatchObject({ recordType: 'session' })
    await rm(sessionPath)
    await expect(iterator.next()).rejects.toThrow('source changed while reading')
  })

  it.each(['message', 'part'])(
    'detects a new %s file added after snapshot enumeration',
    async (kind) => {
      await writeConversation()
      const iterator = readOpenCodeLegacyTranscriptRecords({
        sessionId,
        transcriptPath: sessionPath
      })
      expect((await iterator.next()).value).toMatchObject({ recordType: 'session' })
      await writeRecord(kind === 'message' ? messagePath('msg_new') : partPath('prt_new'), {
        id: kind === 'message' ? 'msg_new' : 'prt_new',
        sessionID: sessionId,
        messageID: messageId
      })
      expect((await iterator.next()).value).toMatchObject({ recordType: 'message' })
      expect((await iterator.next()).value).toMatchObject({ recordType: 'part' })
      await expect(iterator.next()).rejects.toThrow('source changed while reading')
    }
  )

  it('detects creation of a previously absent message directory while yielding', async () => {
    const iterator = readOpenCodeLegacyTranscriptRecords({ sessionId, transcriptPath: sessionPath })
    expect((await iterator.next()).value).toMatchObject({ recordType: 'session' })
    await writeRecord(messagePath(), { id: messageId, sessionID: sessionId })
    await expect(iterator.next()).rejects.toThrow('source changed while reading')
  })
})
