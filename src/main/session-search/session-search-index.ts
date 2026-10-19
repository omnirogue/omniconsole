import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchWriteBatch } from './session-search-write-batch'
import { findSummaryCandidates, type SummaryCandidateWindow } from './session-summary-candidates'
import {
  SCHEMA,
  num,
  toSessionRow,
  type IndexChunk,
  type IndexedFileRow,
  type Row,
  type SessionRow,
  type SessionTermCount
} from './session-search-index-rows'
import type {
  SessionSearchAgent,
  SessionSearchRole,
  SessionSearchSummarySource
} from '../../shared/session-search-types'
import {
  SESSION_SEARCH_MARK_CLOSE,
  SESSION_SEARCH_MARK_OPEN
} from '../../shared/session-search-types'

// One chunk rowid carries its session: rowid = sid * 2^20 + seq. A term's per-session counts
// then come straight from the FTS doclist (`rowid >> 20`) without touching stored text, which
// keeps a common word fast on a host with tens of thousands of transcripts.
const SEQ_BITS = 20
const SEQ_SPAN = 2 ** SEQ_BITS
// Why: better-sqlite3 binds numbers as REAL, and a REAL rowid bound makes FTS5 scan every chunk.
const IN_SESSION = 'rowid >= CAST(? AS INTEGER) AND rowid < CAST(? AS INTEGER)'
export const MAX_CHUNKS_PER_SESSION = 60_000
const SCHEMA_VERSION = '1'

export type { IndexChunk, IndexedFileRow, SessionRow, SessionTermCount }

export class SessionSearchIndex {
  private readonly db: SyncDatabase
  /** Groups a pass's writes into few commits (see SessionSearchWriteBatch). */
  readonly writes: SessionSearchWriteBatch

  constructor(path: string) {
    this.db = new SyncDatabase(path, { timeout: 5_000 })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA)
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
      | Row
      | undefined
    if (version && version.value !== SCHEMA_VERSION) {
      this.db.exec(
        'DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS outputs;'
      )
      this.db.exec(SCHEMA)
    }
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)")
      .run(SCHEMA_VERSION)
    this.writes = new SessionSearchWriteBatch(this.db)
  }

  close(): void {
    this.db.close()
  }

  /** One unit of work; inside an open batch it is a savepoint that rolls back alone. */
  transaction<T>(work: () => T): T {
    return this.writes.transaction(work)
  }

  getFile(path: string): IndexedFileRow | null {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as Row | undefined
    return row
      ? {
          path,
          sid: num(row.sid),
          size: num(row.size),
          mtimeMs: num(row.mtime_ms),
          offset: num(row.offset)
        }
      : null
  }

  putFile(file: IndexedFileRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO files(path, sid, size, mtime_ms, offset) VALUES (?, ?, ?, ?, ?)'
      )
      .run(file.path, file.sid, file.size, Math.round(file.mtimeMs), file.offset)
  }

  ensureSession(args: {
    sessionKey: string
    agent: SessionSearchAgent
    sessionId: string
    path: string
  }): SessionRow {
    this.db
      .prepare(
        `INSERT INTO sessions(session_key, agent, session_id, path) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET path = excluded.path`
      )
      .run(args.sessionKey, args.agent, args.sessionId, args.path)
    return this.sessionByKey(args.sessionKey)!
  }

  sessionByKey(sessionKey: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(sessionKey) as
      | Row
      | undefined
    return row ? toSessionRow(row) : null
  }

  /** Lightweight path lookup used before full session hydration when checking hardlink aliases. */
  sessionPathByKey(sessionKey: string): string | null {
    const row = this.db
      .prepare('SELECT path FROM sessions WHERE session_key = ?')
      .get(sessionKey) as Row | undefined
    return typeof row?.path === 'string' ? row.path : null
  }

  sessionsBySid(sids: readonly number[]): Map<number, SessionRow> {
    const out = new Map<number, SessionRow>()
    for (let start = 0; start < sids.length; start += 200) {
      const batch = sids.slice(start, start + 200)
      const rows = this.db
        .prepare(`SELECT * FROM sessions WHERE sid IN (${batch.map(() => '?').join(',')})`)
        .all(...batch) as Row[]
      for (const row of rows) {
        const session = toSessionRow(row)
        out.set(session.sid, session)
      }
    }
    return out
  }

  /** Drop everything indexed for a session, e.g. when its file was rewritten. */
  resetSession(sid: number): void {
    for (const table of ['chunks', 'outputs']) {
      this.db
        .prepare(`DELETE FROM ${table} WHERE ${IN_SESSION}`)
        .run(sid * SEQ_SPAN, (sid + 1) * SEQ_SPAN)
    }
    this.db
      .prepare(
        `UPDATE sessions SET next_seq = 0, text_bytes = 0, user_turns = 0, first_ask = NULL,
         last_ask = NULL, last_answer = NULL, links = '[]', first_ts = NULL, last_ts = NULL
         WHERE sid = ?`
      )
      .run(sid)
  }

  /** Append chunks after the session's last one; returns how many were stored. */
  appendChunks(session: SessionRow, chunks: readonly IndexChunk[]): number {
    const insert = this.db.prepare('INSERT INTO chunks(rowid, text, role, ts) VALUES (?, ?, ?, ?)')
    // Why: tool output is most of the text but never a snippet, so it is indexed without a copy.
    const insertOutput = this.db.prepare('INSERT INTO outputs(rowid, text) VALUES (?, ?)')
    const startSeq = session.nextSeq
    let seq = startSeq
    let bytes = 0
    for (const chunk of chunks) {
      // Why: counted even past the cap, so a long session's summary still notices new work.
      bytes += chunk.text.length
      if (seq >= MAX_CHUNKS_PER_SESSION) {
        continue
      }
      if (chunk.output) {
        insertOutput.run(session.sid * SEQ_SPAN + seq, chunk.text)
      } else {
        insert.run(session.sid * SEQ_SPAN + seq, chunk.text, chunk.role, chunk.ts)
      }
      seq += 1
    }
    session.nextSeq = seq
    session.textBytes += bytes
    return seq - startSeq
  }

  saveSessionFacts(session: SessionRow): void {
    this.db
      .prepare(
        `UPDATE sessions SET path = ?, title = ?, title_rank = ?, cwd = ?, kind = ?, first_ts = ?,
         last_ts = ?, user_turns = ?, next_seq = ?, text_bytes = ?, first_ask = ?, last_ask = ?, last_answer = ?,
         links = ? WHERE sid = ?`
      )
      .run(
        session.path,
        session.title,
        session.titleRank,
        session.cwd,
        session.kind,
        session.firstTs,
        session.lastTs,
        session.userTurns,
        session.nextSeq,
        session.textBytes,
        session.firstAsk,
        session.lastAsk,
        session.lastAnswer,
        JSON.stringify(session.links),
        session.sid
      )
  }

  saveSummary(
    session: SessionRow,
    summary: string,
    source: SessionSearchSummarySource,
    embedding: Uint8Array | null
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET summary = ?, summary_source = ?, summary_basis_bytes = ?, embedding = ?
         WHERE sid = ?`
      )
      .run(summary, source, session.textBytes, embedding, session.sid)
    this.db.prepare('DELETE FROM docs WHERE rowid = ?').run(session.sid)
    this.db
      .prepare('INSERT INTO docs(rowid, title, summary, cwd) VALUES (?, ?, ?, ?)')
      .run(session.sid, session.title ?? '', summary, session.cwd ?? '')
  }

  /** Per-session hit counts for one FTS expression over asks, replies and tool output. */
  termCounts(expression: string): SessionTermCount[] {
    const counts = new Map<number, number>()
    for (const table of ['chunks', 'outputs']) {
      const rows = this.db
        .prepare(
          `SELECT rowid >> ${SEQ_BITS} AS sid, count(*) AS n FROM ${table} WHERE ${table} MATCH ?
           GROUP BY sid`
        )
        .all(expression) as Row[]
      for (const row of rows) {
        counts.set(num(row.sid), (counts.get(num(row.sid)) ?? 0) + num(row.n))
      }
    }
    return [...counts].map(([sid, count]) => ({ sid, count }))
  }

  /** Sessions whose title (or, with `column` omitted, title/summary/folder) matches. */
  docMatches(expression: string, column?: 'title' | 'summary'): Set<number> {
    const match = column ? `${column} : (${expression})` : expression
    const rows = this.db
      .prepare('SELECT rowid AS sid FROM docs WHERE docs MATCH ?')
      .all(match) as Row[]
    return new Set(rows.map((row) => num(row.sid)))
  }

  /** Passages that match, what was said before tool calls: a preview reads as the conversation. */
  snippets(
    sid: number,
    expression: string,
    limit: number
  ): { role: SessionSearchRole; text: string }[] {
    const rows = this.db
      .prepare(
        `SELECT role, snippet(chunks, 0, ?, ?, '…', 20) AS text FROM chunks
         WHERE chunks MATCH ? AND ${IN_SESSION}
         ORDER BY CASE role WHEN 'tool' THEN 1 ELSE 0 END, rank LIMIT ?`
      )
      .all(
        SESSION_SEARCH_MARK_OPEN,
        SESSION_SEARCH_MARK_CLOSE,
        expression,
        sid * SEQ_SPAN,
        (sid + 1) * SEQ_SPAN,
        limit
      ) as Row[]
    return rows.map((row) => ({
      role: row.role === 'user' || row.role === 'assistant' ? row.role : 'tool',
      text: String(row.text ?? '')
    }))
  }

  /** Chunk count per session: the document length for session-level BM25. */
  sessionLengths(): Map<number, number> {
    const rows = this.db.prepare('SELECT sid, next_seq FROM sessions').all() as Row[]
    return new Map(rows.map((row) => [num(row.sid), num(row.next_seq)]))
  }

  sidecarSids(): Set<number> {
    const rows = this.db.prepare("SELECT sid FROM sessions WHERE kind = 'sidecar'").all() as Row[]
    return new Set(rows.map((row) => num(row.sid)))
  }

  /** A session's asks and replies in order (chunks of one long reply stay separate). */
  conversationTurns(sid: number): { role: 'user' | 'assistant'; text: string }[] {
    const rows = this.db
      .prepare(
        `SELECT role, text FROM chunks WHERE ${IN_SESSION} AND role != 'tool'
         ORDER BY rowid`
      )
      .all(sid * SEQ_SPAN, (sid + 1) * SEQ_SPAN) as Row[]
    return rows.map((row) => ({
      role: row.role === 'user' ? 'user' : 'assistant',
      text: String(row.text ?? '')
    }))
  }

  embeddings(): { sid: number; blob: Uint8Array }[] {
    const rows = this.db
      .prepare('SELECT sid, embedding FROM sessions WHERE embedding IS NOT NULL')
      .all() as Row[]
    return rows.map((row) => ({ sid: num(row.sid), blob: row.embedding as Uint8Array }))
  }

  sessionsNeedingModelSummary(args: SummaryCandidateWindow): SessionRow[] {
    return findSummaryCandidates(this.db, args)
  }

  /** Work sessions active since `activeSince`, newest first (the omnios Work feed's window). */
  sessionsActiveSince(activeSince: number, limit: number): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE kind = 'work' AND last_ts >= ? ORDER BY last_ts DESC LIMIT ?`
      )
      .all(activeSince, limit) as Row[]
    return rows.map(toSessionRow)
  }

  /**
   * When the conversation itself last moved: its newest ask or reply. A session's `last_ts` also
   * counts the system lines an app restart appends to every restored transcript, which would put a
   * week-old session at the top of today's Work feed.
   */
  lastConversationTs(sid: number): number | null {
    const row = this.db
      .prepare(`SELECT max(ts) AS ts FROM chunks WHERE ${IN_SESSION} AND role != 'tool'`)
      .get(sid * SEQ_SPAN, (sid + 1) * SEQ_SPAN) as Row | undefined
    return row?.ts === null || row?.ts === undefined ? null : num(row.ts)
  }

  counts(): { sessions: number; files: number } {
    const sessions = this.db.prepare('SELECT count(*) AS n FROM sessions').get() as Row
    const files = this.db.prepare('SELECT count(*) AS n FROM files').get() as Row
    return { sessions: num(sessions.n), files: num(files.n) }
  }
}
