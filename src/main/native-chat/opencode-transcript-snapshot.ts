import { mkdtemp, open, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeChatTranscriptPageArgs } from '../../shared/native-chat-transcript-page'
import { readOpenCodeLegacyTranscriptRecords } from './opencode-legacy-transcript-records'
import {
  readOpenCodeSqliteTranscriptRecords,
  resolveOpenCodeTranscriptDatabase,
  type OpenCodeTranscriptRecord
} from './opencode-sqlite-transcript-records'

const SNAPSHOT_TTL_MS = 30 * 60 * 1000
const MAX_OPEN_SNAPSHOTS = 64
const RECORD_CHUNK_CHARACTERS = 16 * 1024
const snapshots = new Map<string, OpenCodeTranscriptSnapshot>()
let creatingSnapshots = 0

type OpenCodeTranscriptSnapshot = {
  filePath: string
  directory: string
  sessionId: string
  originalPath: string | undefined
  timer: ReturnType<typeof setTimeout>
}

export async function resolveOpenCodeTranscriptSnapshot(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  if (args.connectionId || args.cursor?.connectionId) {
    throw new Error('OpenCode transcript storage must be read on its owning host.')
  }
  if (
    args.agent !== 'opencode' ||
    args.sessionId.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(args.sessionId)
  ) {
    throw new Error('Choose a valid OpenCode session identifier.')
  }
  if (args.cursor) {
    const snapshot = snapshots.get(args.cursor.filePath)
    if (
      !snapshot ||
      snapshot.sessionId !== args.sessionId ||
      args.cursor.agent !== args.agent ||
      args.cursor.sessionId !== args.sessionId ||
      (args.transcriptPath && args.transcriptPath !== snapshot.originalPath)
    ) {
      throw new Error(
        'The OpenCode capture expired or its cursor belongs to a different source. Restart capture.'
      )
    }
    snapshot.timer.refresh()
    return snapshot.filePath
  }
  if (snapshots.size + creatingSnapshots >= MAX_OPEN_SNAPSHOTS) {
    throw new Error(
      'Too many OpenCode transcript captures are open. Retry after existing captures expire.'
    )
  }
  creatingSnapshots++
  try {
    return await createSnapshot(args, signal)
  } finally {
    creatingSnapshots--
  }
}

async function createSnapshot(
  args: NativeChatTranscriptPageArgs,
  signal?: AbortSignal
): Promise<string> {
  const dbPath = await resolveOpenCodeTranscriptDatabase(args)
  signal?.throwIfAborted()
  const records = dbPath
    ? readOpenCodeSqliteTranscriptRecords({ dbPath, sessionId: args.sessionId }, signal)
    : readOpenCodeLegacyTranscriptRecords(args, signal)
  const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-transcript-'))
  const filePath = join(directory, 'source.jsonl')
  try {
    const file = await open(filePath, 'wx', 0o600)
    try {
      for await (const record of records) {
        signal?.throwIfAborted()
        for (const line of encodeOpenCodeTranscriptRecord(record)) {
          signal?.throwIfAborted()
          await file.writeFile(`${line}\n`)
        }
      }
      signal?.throwIfAborted()
    } finally {
      await file.close()
    }
    const timer = setTimeout(() => {
      void removeSnapshot(filePath)
    }, SNAPSHOT_TTL_MS)
    timer.unref()
    snapshots.set(filePath, {
      filePath,
      directory,
      sessionId: args.sessionId,
      originalPath: args.transcriptPath,
      timer
    })
    return filePath
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

// Each chunk is independently valid JSON; concatenating `text` restores the exact source record.
export function* encodeOpenCodeTranscriptRecord(
  record: OpenCodeTranscriptRecord
): Generator<string> {
  const recordId =
    record.recordId.length <= 512
      ? record.recordId
      : `sha256:${createHash('sha256').update(record.recordId).digest('hex')}`
  if (record.text.length <= RECORD_CHUNK_CHARACTERS) {
    yield JSON.stringify({ kind: 'opencode-record', ...record, recordId })
    return
  }
  let chunkIndex = 0
  for (let offset = 0; offset < record.text.length;) {
    let end = Math.min(offset + RECORD_CHUNK_CHARACTERS, record.text.length)
    const lastUnit = record.text.charCodeAt(end - 1)
    if (end < record.text.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      end--
    }
    yield JSON.stringify({
      kind: 'opencode-record-chunk',
      recordType: record.recordType,
      recordId,
      chunkIndex: chunkIndex++,
      complete: end === record.text.length,
      text: record.text.slice(offset, end)
    })
    offset = end
  }
}

export async function disposeOpenCodeTranscriptSnapshots(): Promise<void> {
  await Promise.all([...snapshots.keys()].map(removeSnapshot))
}

async function removeSnapshot(filePath: string): Promise<void> {
  const snapshot = snapshots.get(filePath)
  if (!snapshot) {
    return
  }
  snapshots.delete(filePath)
  clearTimeout(snapshot.timer)
  await rm(snapshot.directory, { recursive: true, force: true }).catch(() => {})
}
