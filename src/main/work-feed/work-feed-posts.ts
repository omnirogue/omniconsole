import { createHash } from 'node:crypto'
import type { SessionSearchFeedRow } from '../session-search/session-search-service-protocol'
import { redactTranscriptText } from '../session-search/session-search-redaction'

/**
 * Which of this computer's indexed sessions are posts in the omnios Work feed, and what each
 * post says. A post is a session a person worked in; the console reads its status from the
 * summary and scrubs every text again before storing it (omni-console `work_feed.py`).
 */
export type WorkFeedPost = {
  agent: 'claude' | 'codex'
  session_id: string
  source_kind?: 'session'
  host: string
  title: string | null
  folder: string | null
  started_at: number | null
  last_at: number
  turns: number
  workers: number
  summary: string | null
  summary_source: 'model' | 'extractive' | null
  first_ask: string | null
  last_answer: string | null
  links: string[]
}

export type WorkFeedWorkerMarker = Pick<WorkFeedPost, 'agent' | 'session_id'> & {
  source_kind: 'internal_worker'
}

export type WorkFeedPublication = WorkFeedPost | WorkFeedWorkerMarker

/** Markers retire existing posts; the server never creates a post from one. */
export function workFeedWorkerMarkers(
  rows: readonly SessionSearchFeedRow[]
): WorkFeedWorkerMarker[] {
  return rows
    .filter((row) => row.origin.worker || row.origin.parentSessionId)
    .map((row) => ({ agent: row.agent, session_id: row.sessionId, source_kind: 'internal_worker' }))
}

/** One-shot probes and OmniConsole's own helper prompts, which are never a person's work. */
const PROBE_ASK =
  /^(?:reply with|you write the search summary|you match shipped code changes|use the update_plan tool once|bounded deployment verification|you are an advisor\. read the plan below)/i
/** Scheduled routine runs: a routine's own result page is where its work is read. */
const ROUTINE_ASK =
  /^(?:[Rr]outine definition context:|<scheduled-task\b|[A-Z0-9 &+-]{3,80}ROUTINE\b.{0,40}\bevery \d+ minutes)/
/** A worker an OmniConsole orchestration dispatched: its coordinator's session is the post. */
const DISPATCHED_WORKER_ASK =
  /^You are working inside OmniConsole, a multi-agent IDE\. You are a dispatched worker\b/
/** A one-word opener ("ok", "here") that got nothing but a greeting back is not work. */
const TRIVIAL_ASK_CHARS = 12
const TRIVIAL_TEXT_BYTES = 4_000
const LINKS_MAX = 40

function helperFolder(cwd: string | null, helperDirs: readonly string[]): boolean {
  if (!cwd) {
    return false
  }
  return (
    cwd.includes('/Library/Application Support/') || helperDirs.some((dir) => cwd.startsWith(dir))
  )
}

export function isWorkFeedSession(
  row: SessionSearchFeedRow,
  helperDirs: readonly string[] = []
): boolean {
  if (
    row.origin.worker ||
    row.lastTs === null ||
    row.userTurns < 1 ||
    helperFolder(row.cwd, helperDirs)
  ) {
    return false
  }
  const ask = (row.firstAsk ?? '').trim()
  if (PROBE_ASK.test(ask) || ROUTINE_ASK.test(ask) || DISPATCHED_WORKER_ASK.test(ask)) {
    return false
  }
  // Why two turns: an SDK session a person chats in (OmniConsole's native chat) has many asks;
  // a headless one-shot run (`claude -p`, `codex exec`) has exactly one.
  if (row.origin.headless && row.userTurns < 2) {
    return false
  }
  return !(
    ask.length < TRIVIAL_ASK_CHARS &&
    row.userTurns <= 1 &&
    row.textBytes < TRIVIAL_TEXT_BYTES
  )
}

function redact(text: string | null): string | null {
  return text ? redactTranscriptText(text) : text
}

/**
 * The posts for `rows` (one computer's sessions in the feed's window). A Codex worker is never a
 * post of its own: it counts toward the session that spawned it, as that post's `workers`.
 */
export function buildWorkFeedPosts(
  rows: readonly SessionSearchFeedRow[],
  host: string,
  helperDirs: readonly string[] = []
): WorkFeedPost[] {
  const workers = new Map<string, number>()
  for (const row of rows) {
    const parent = row.origin.parentSessionId
    if (parent) {
      workers.set(`${row.agent}:${parent}`, (workers.get(`${row.agent}:${parent}`) ?? 0) + 1)
    }
  }
  const posts: WorkFeedPost[] = []
  for (const row of rows) {
    if (row.origin.parentSessionId || !isWorkFeedSession(row, helperDirs)) {
      continue
    }
    posts.push({
      agent: row.agent,
      session_id: row.sessionId,
      host,
      title: redact(row.title),
      folder: row.cwd,
      started_at: row.firstTs,
      last_at: row.lastTs!,
      turns: row.userTurns,
      workers: workers.get(`${row.agent}:${row.sessionId.toLowerCase()}`) ?? 0,
      summary: redact(row.summary),
      summary_source: row.summarySource,
      first_ask: redact(row.firstAsk),
      last_answer: redact(row.lastAnswer),
      links: row.links.slice(-LINKS_MAX)
    })
  }
  return posts
}

/** What was last sent for a post; a post is sent again only when this changes. */
export function workFeedFingerprint(post: WorkFeedPost): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        post.last_at,
        post.title,
        post.summary,
        post.summary_source,
        post.workers,
        post.turns,
        post.links.length
      ])
    )
    .digest('hex')
    .slice(0, 24)
}

export function workFeedPostKey(post: Pick<WorkFeedPost, 'agent' | 'session_id'>): string {
  return `${post.agent}:${post.session_id}`
}
