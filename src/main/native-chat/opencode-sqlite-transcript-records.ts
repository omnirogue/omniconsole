import { extname } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  readOpenCodeDatabase,
  openCodeBusyTimeoutMs
} from '../ai-vault/session-scanner-opencode-sqlite-open'
import { splitOpenCodeSqliteCandidate } from '../ai-vault/session-scanner-opencode-sqlite-paths'
import {
  compareOpenCodeClaimPriority,
  listOpenCodeDatabases
} from '../opencode-usage/opencode-database-discovery'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import SyncDatabase from '../sqlite/sync-database'

export type OpenCodeTranscriptRecord = {
  recordType: 'session' | 'message' | 'part'
  recordId: string
  text: string
}

export async function resolveOpenCodeTranscriptDatabase(args: {
  sessionId: string
  transcriptPath?: string
}): Promise<string | null> {
  const candidate = args.transcriptPath && splitOpenCodeSqliteCandidate(args.transcriptPath)
  if (candidate && candidate.sessionId !== args.sessionId) {
    throw new Error('The OpenCode database path belongs to a different source session.')
  }
  if (args.transcriptPath && extname(args.transcriptPath) === '.json') {
    return null
  }
  const paths = args.transcriptPath
    ? [candidate ? candidate.dbPath : args.transcriptPath]
    : (
        await listOpenCodeDatabases((_path, error) => {
          throw error
        })
      ).sort(compareOpenCodeClaimPriority)
  for (const dbPath of paths) {
    assertNativeDatabasePath(dbPath)
    const exists = readOpenCodeDatabase({
      dbPath,
      read: (db) => {
        if (!tableExists(db, 'session') || !columnExists(db, 'session', 'id')) {
          throw new Error('The OpenCode database has no readable session table.')
        }
        return Boolean(
          db.prepare('SELECT id FROM session WHERE id = ? LIMIT 1').get(args.sessionId)
        )
      }
    })
    if (exists) {
      return dbPath
    }
  }
  if (args.transcriptPath) {
    throw Object.assign(new Error('OpenCode session unavailable in its owning database.'), {
      code: 'ENOENT'
    })
  }
  return null
}

export async function* readOpenCodeSqliteTranscriptRecords(
  args: {
    dbPath: string
    sessionId: string
  },
  signal?: AbortSignal
): AsyncGenerator<OpenCodeTranscriptRecord> {
  assertNativeDatabasePath(args.dbPath)
  const db = new SyncDatabase(args.dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: openCodeBusyTimeoutMs(args.dbPath)
  })
  try {
    db.pragma('query_only = ON')
    db.exec('BEGIN')
    const sessionQuery = db.prepare('SELECT * FROM session WHERE id = ?')
    sessionQuery.setReadBigInts(true)
    const session = sessionQuery.get(args.sessionId)
    if (!session) {
      throw Object.assign(new Error('OpenCode session disappeared before capture.'), {
        code: 'ENOENT'
      })
    }
    for (const [table, column] of [
      ['message', 'session_id'],
      ['part', 'message_id']
    ] as const) {
      if (
        !tableExists(db, table) ||
        !columnExists(db, table, column) ||
        !columnExists(db, table, 'id')
      ) {
        throw new Error(`The OpenCode database has no complete ${table} storage schema.`)
      }
    }
    yield encodeRow('session', session)
    const messageOrder = columnExists(db, 'message', 'time_created') ? 'time_created, id' : 'id'
    for (const row of readRows(
      db,
      `SELECT * FROM message WHERE session_id = ? ORDER BY ${messageOrder}`,
      args.sessionId
    )) {
      signal?.throwIfAborted()
      yield encodeRow('message', row)
    }
    const partScope = columnExists(db, 'part', 'session_id')
      ? 'session_id = ?'
      : 'message_id IN (SELECT id FROM message WHERE session_id = ?)'
    const partOrder = columnExists(db, 'part', 'time_created') ? 'time_created, id' : 'id'
    for (const row of readRows(
      db,
      `SELECT * FROM part WHERE ${partScope} ORDER BY ${partOrder}`,
      args.sessionId
    )) {
      signal?.throwIfAborted()
      yield encodeRow('part', row)
    }
    signal?.throwIfAborted()
  } finally {
    db.close()
  }
}

function readRows(db: SyncDatabase, sql: string, sessionId: string) {
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  return statement.iterate(sessionId)
}

function encodeRow(
  recordType: OpenCodeTranscriptRecord['recordType'],
  row: Record<string, unknown>
): OpenCodeTranscriptRecord {
  return {
    recordType,
    recordId: String(row.id),
    text: JSON.stringify(row, (_key, value: unknown) => {
      if (typeof value === 'bigint') {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : { sqliteType: 'integer', decimal: value.toString() }
      }
      if (value instanceof Uint8Array) {
        return { sqliteType: 'blob', base64: Buffer.from(value).toString('base64') }
      }
      return value
    })
  }
}

function assertNativeDatabasePath(dbPath: string): void {
  if (isWslUncPath(dbPath)) {
    throw new Error(
      'OpenCode SQLite transcripts must be captured by the runtime inside their owning WSL distro.'
    )
  }
}
