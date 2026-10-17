import type {
  SessionSearchAgent,
  SessionSearchRole,
  SessionSearchSummarySource
} from '../../shared/session-search-types'

const TOKENIZER = "tokenize = 'unicode61 remove_diacritics 2'"

export type IndexedFileRow = {
  path: string
  sid: number
  size: number
  mtimeMs: number
  offset: number
}

export type SessionRow = {
  sid: number
  sessionKey: string
  agent: SessionSearchAgent
  sessionId: string
  path: string
  title: string | null
  titleRank: number
  cwd: string | null
  /** `sidecar`: OmniConsole's own helper runs, which quote other sessions and are never results. */
  kind: 'work' | 'sidecar'
  firstTs: number | null
  lastTs: number | null
  userTurns: number
  nextSeq: number
  textBytes: number
  firstAsk: string | null
  lastAsk: string | null
  lastAnswer: string | null
  links: string[]
  summary: string | null
  summarySource: SessionSearchSummarySource | null
  summaryBasisBytes: number
}

export type SessionTermCount = { sid: number; count: number }

export type IndexChunk = {
  role: SessionSearchRole
  text: string
  ts: number | null
  output?: true
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  sid INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL UNIQUE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT, title_rank INTEGER NOT NULL DEFAULT 0,
  cwd TEXT, first_ts INTEGER, last_ts INTEGER, kind TEXT NOT NULL DEFAULT 'work',
  user_turns INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0,
  first_ask TEXT, last_ask TEXT, last_answer TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  summary TEXT, summary_source TEXT, summary_basis_bytes INTEGER NOT NULL DEFAULT 0,
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  sid INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  offset INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, role UNINDEXED, ts UNINDEXED, ${TOKENIZER});
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(title, summary, cwd, ${TOKENIZER});
CREATE VIRTUAL TABLE IF NOT EXISTS outputs USING fts5(text, content='', contentless_delete=1, ${TOKENIZER});
`

export type Row = Record<string, unknown>

export const num = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0)
export const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function toSessionRow(row: Row): SessionRow {
  let links: string[] = []
  try {
    const parsed = JSON.parse(String(row.links ?? '[]'))
    links = Array.isArray(parsed) ? parsed.filter((link) => typeof link === 'string') : []
  } catch {
    links = []
  }
  const source = str(row.summary_source)
  return {
    sid: num(row.sid),
    sessionKey: String(row.session_key),
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    sessionId: String(row.session_id),
    path: String(row.path),
    title: str(row.title),
    titleRank: num(row.title_rank),
    cwd: str(row.cwd),
    kind: row.kind === 'sidecar' ? 'sidecar' : 'work',
    firstTs: row.first_ts === null ? null : num(row.first_ts),
    lastTs: row.last_ts === null ? null : num(row.last_ts),
    userTurns: num(row.user_turns),
    nextSeq: num(row.next_seq),
    textBytes: num(row.text_bytes),
    firstAsk: str(row.first_ask),
    lastAsk: str(row.last_ask),
    lastAnswer: str(row.last_answer),
    links,
    summary: str(row.summary),
    summarySource: source === 'model' || source === 'extractive' ? source : null,
    summaryBasisBytes: num(row.summary_basis_bytes)
  }
}
