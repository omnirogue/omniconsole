import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type {
  NativeChatTranscriptPageArgs,
  NativeChatTranscriptPageResult
} from '../../shared/native-chat-transcript-page'
import { readOpenCodeTranscriptPage } from './opencode-transcript-page'
import {
  disposeOpenCodeTranscriptSnapshots,
  encodeOpenCodeTranscriptRecord
} from './opencode-transcript-snapshot'
import {
  readOpenCodeSqliteTranscriptRecords,
  type OpenCodeTranscriptRecord
} from './opencode-sqlite-transcript-records'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await disposeOpenCodeTranscriptSnapshots()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<NativeChatTranscriptPageArgs> {
  const root = await mkdtemp(join(tmpdir(), 'omni-opencode-capture-test-'))
  roots.push(root)
  const transcriptPath = join(root, 'opencode.db')
  const db = new Database(transcriptPath)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, extra TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`)
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_one', 'Original', 'all metadata')
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_other', 'Other', 'private')
    const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    message.run(
      'msg_user',
      'ses_one',
      1,
      JSON.stringify({ role: 'user', content: 'full user question', custom: 7 })
    )
    message.run(
      'msg_assistant',
      'ses_one',
      2,
      JSON.stringify({ role: 'assistant', content: 'full assistant answer' })
    )
    message.run(
      'msg_other',
      'ses_other',
      1,
      JSON.stringify({ role: 'user', content: 'other session' })
    )
    const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    part.run(
      'part_tool',
      'ses_one',
      'msg_assistant',
      3,
      JSON.stringify({ type: 'tool', state: { output: 'complete tool result' } })
    )
    part.run(
      'part_unknown',
      'ses_one',
      'msg_assistant',
      4,
      JSON.stringify({ type: 'future-type', opaque: [1, 2, 3] })
    )
    part.run(
      'part_other',
      'ses_other',
      'msg_other',
      2,
      JSON.stringify({ type: 'text', text: 'other private result' })
    )
  } finally {
    db.close()
  }
  return { agent: 'opencode', sessionId: 'ses_one', transcriptPath }
}

function success(result: NativeChatTranscriptPageResult) {
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result
}

async function capture(args: NativeChatTranscriptPageArgs) {
  const records: {
    recordType: string
    recordId: string
    text: string
    chunkIndex?: number
    complete?: boolean
  }[] = []
  let priorOffset = -1
  let snapshotBytes: number | undefined
  for (let count = 0; count < 1000; count++) {
    const page = success(await readOpenCodeTranscriptPage(args))
    snapshotBytes ??= page.coverage.snapshotBytes
    expect(page.coverage.snapshotBytes).toBe(snapshotBytes)
    expect(page.coverage.toByteOffset).toBeGreaterThan(priorOffset)
    expect(page.coverage.rawRecords).toBe('complete')
    priorOffset = page.coverage.toByteOffset
    records.push(...page.sourceRecords.map((record) => JSON.parse(record.text)))
    if (page.complete) {
      return records
    }
    expect(page.cursor).toBeDefined()
    args = { ...args, cursor: page.cursor }
  }
  throw new Error('OpenCode capture did not complete')
}

describe('OpenCode owning-host transcript capture', () => {
  it('exports all message, tool, unknown part and session fields without unrelated session data', async () => {
    const records = await capture({ ...(await fixture()), limit: 1 })
    expect(records.map((record) => [record.recordType, record.recordId])).toEqual([
      ['session', 'ses_one'],
      ['message', 'msg_user'],
      ['message', 'msg_assistant'],
      ['part', 'part_tool'],
      ['part', 'part_unknown']
    ])
    expect(JSON.parse(records[0]!.text).extra).toBe('all metadata')
    expect(records.map((record) => record.text).join('\n')).toContain('complete tool result')
    expect(JSON.parse(JSON.parse(records[4]!.text).data).opaque).toEqual([1, 2, 3])
  })

  it('keeps a stable transcript when OpenCode rewrites and appends after page one', async () => {
    const args = { ...(await fixture()), limit: 1 }
    const first = success(await readOpenCodeTranscriptPage(args))
    const db = new Database(args.transcriptPath!)
    try {
      db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
        '{"role":"user","content":"changed"}',
        'msg_user'
      )
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg_new',
        'ses_one',
        9,
        '{"content":"new"}'
      )
    } finally {
      db.close()
    }
    const rest = await capture({ ...args, cursor: first.cursor })
    expect(rest.map((record) => record.text).join('\n')).toContain('full user question')
    expect(rest.some((record) => record.recordId === 'msg_new')).toBe(false)
  })

  it('holds a consistent SQLite read transaction while the export is being written', async () => {
    const args = await fixture()
    const records = readOpenCodeSqliteTranscriptRecords({
      dbPath: args.transcriptPath!,
      sessionId: args.sessionId
    })
    expect((await records.next()).value?.recordType).toBe('session')
    const writer = new Database(args.transcriptPath!)
    try {
      writer
        .prepare('UPDATE message SET data = ? WHERE id = ?')
        .run('{"content":"rewrite during export"}', 'msg_user')
      writer.prepare('DELETE FROM part WHERE id = ?').run('part_tool')
    } finally {
      writer.close()
    }
    const remaining: OpenCodeTranscriptRecord[] = []
    for await (const record of records) {
      remaining.push(record)
    }
    expect(remaining.map((record) => record.text).join('\n')).toContain('full user question')
    expect(remaining.some((record) => record.recordId === 'part_tool')).toBe(true)
  })

  it('reassembles a tool result larger than the generic transcript record limit exactly', async () => {
    const args = await fixture()
    const data = JSON.stringify({ type: 'tool', state: { output: '🚀\\\"\n'.repeat(400_000) } })
    const db = new Database(args.transcriptPath!)
    try {
      db.prepare('UPDATE part SET data = ? WHERE id = ?').run(data, 'part_tool')
    } finally {
      db.close()
    }
    const records = await capture({ ...args, limit: 4 })
    const chunks = records.filter((record) => record.recordId === 'part_tool')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)?.complete).toBe(true)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
    expect(JSON.parse(chunks.map((chunk) => chunk.text).join('')).data === data).toBe(true)
  })

  it('resolves OPENCODE_DB on the owning host when no transcript path was recorded', async () => {
    const args = await fixture()
    vi.stubEnv('OPENCODE_DB', args.transcriptPath!)
    const records = await capture({ agent: 'opencode', sessionId: args.sessionId })
    expect(records[0]?.recordId).toBe('ses_one')
  })

  it('accepts the scanner synthetic SQLite path and fences its session id', async () => {
    const args = await fixture()
    expect(
      success(
        await readOpenCodeTranscriptPage({
          ...args,
          transcriptPath: `${args.transcriptPath}#ses_one`
        })
      ).complete
    ).toBe(true)
    expect(
      await readOpenCodeTranscriptPage({
        ...args,
        transcriptPath: `${args.transcriptPath}#ses_other`
      })
    ).toMatchObject({ error: expect.stringContaining('different source session') })
  })

  it('rejects cross-session cursors and never falls back to local storage for SSH', async () => {
    const args = await fixture()
    const first = success(await readOpenCodeTranscriptPage({ ...args, limit: 1 }))
    expect(
      await readOpenCodeTranscriptPage({ ...args, sessionId: 'ses_other', cursor: first.cursor })
    ).toMatchObject({ error: expect.stringContaining('different source') })
    expect(await readOpenCodeTranscriptPage({ ...args, connectionId: 'rented-mac' })).toMatchObject(
      { source: { connectionId: 'rented-mac' }, error: expect.stringContaining('owning host') }
    )
  })

  it('reports a missing session and rejects unsupported storage schemas', async () => {
    const args = await fixture()
    expect(await readOpenCodeTranscriptPage({ ...args, sessionId: 'ses_missing' })).toMatchObject({
      notFound: true
    })
    const db = new Database(args.transcriptPath!)
    try {
      db.exec('DROP TABLE part')
    } finally {
      db.close()
    }
    expect(await readOpenCodeTranscriptPage(args)).toMatchObject({
      error: expect.stringContaining('complete part storage schema')
    })
  })

  it('rejects expired snapshots rather than silently restarting from changed data', async () => {
    const args = await fixture()
    const first = success(await readOpenCodeTranscriptPage({ ...args, limit: 1 }))
    await disposeOpenCodeTranscriptSnapshots()
    expect(await readOpenCodeTranscriptPage({ ...args, cursor: first.cursor })).toMatchObject({
      error: expect.stringContaining('expired')
    })
  })

  it('keeps chunks wire-bounded even when record identifiers are oversized', () => {
    const text = JSON.stringify({ id: 'id'.repeat(100_000), data: '漢'.repeat(40_000) })
    const chunks = [
      ...encodeOpenCodeTranscriptRecord({
        recordType: 'part',
        recordId: 'id'.repeat(100_000),
        text
      })
    ]
    expect(
      chunks.every((chunk) => Buffer.byteLength(JSON.stringify({ text: chunk })) < 256 * 1024)
    ).toBe(true)
    expect(chunks.map((chunk) => JSON.parse(chunk).text).join('') === text).toBe(true)
  })
})
