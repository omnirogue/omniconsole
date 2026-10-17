import type { IndexChunk, SessionRow } from './session-search-index'
import { redactTranscriptText } from './session-search-redaction'
import type { TranscriptLineFacts, TranscriptSearchRecord } from './transcript-search-records'

const ASK_CAP = 1_500
const ANSWER_CAP = 1_500
const CHUNK_CHARS = 1_200
const MAX_LINKS = 24
export const EXTRACTIVE_SUMMARY_MAX_CHARS = 1_100

// Outputs worth naming in a summary: PRs and issues, review pages, wiki docs, artifacts,
// tickets and handoff folders. Other URLs are too noisy to call a session's output.
const LINK_PATTERNS: RegExp[] = [
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/g,
  /https:\/\/gitlab\.com\/[\w./-]+\/-\/merge_requests\/\d+/g,
  /https:\/\/omnios\.omnirogue\.com\/a\/[0-9a-z]{8,}/g,
  /https:\/\/[\w-]+\.slite\.com\/app\/docs\/[\w-]+/g,
  /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g,
  /https:\/\/[\w-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/g,
  /(?:~|\/Users\/[\w.-]+)\/Work\/[^\s'"`)<>\]]*?Handoffs?\/[^\s'"`)<>\]]+/g
]

// First asks of OmniConsole's own helper runs (next-step suggestions, Session prep, this index's
// summaries, commit/PR text, brief drafts): they quote other sessions' transcripts, so matching
// them would duplicate every real hit. Sources: shared/next-step-suggestion-prompt.ts,
// main/session-prep/session-prep-{planner,preparer}.ts, ./session-summary-prompt.ts,
// shared/{commit-message,pull-request}-generation.ts, shared/assisted-brief-drafting-prompt.ts.
const SIDECAR_ASK_PREFIXES = [
  /^You suggest what the person should ask \S+ to do next, after its turn finished\./,
  /^You are preparing the first message for a new autonomous agent session\./,
  /^Correct the prepared session fields\./,
  /^Split the person's request into sessions\./,
  /^You write the search summary for one agent work session\./,
  /^You are generating a single git commit message\./,
  /^You are generating pull request details\./,
  /^You are helping a person shape a request before any work starts\./
]

export function isSidecarAsk(ask: string): boolean {
  return SIDECAR_ASK_PREFIXES.some((prefix) => prefix.test(ask.trimStart()))
}

const NEXT_LINE =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?next(?:\s+(?:action|step)s?)?(?:\*\*)?\s*[:—–-]\s*(.+)/i

function cap(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function extractLinks(text: string): string[] {
  const found: string[] = []
  for (const pattern of LINK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[0].replace(/[.,;:]+$/, ''))
    }
  }
  return found
}

function rememberLinks(session: SessionRow, links: readonly string[]): void {
  if (links.length === 0) {
    return
  }
  // Newest last; a repeat moves to the end so the list reads oldest → most recent.
  const kept = session.links.filter((link) => !links.includes(link))
  session.links = [...kept, ...new Set(links)].slice(-MAX_LINKS)
}

/** Fold one parsed line into the session's running facts (already-redacted text only). */
export function applyLineFacts(
  session: SessionRow,
  facts: TranscriptLineFacts,
  records: readonly TranscriptSearchRecord[]
): void {
  if (facts.title && facts.title.rank >= session.titleRank) {
    session.title = redactTranscriptText(facts.title.text)
    session.titleRank = facts.title.rank
  }
  if (facts.cwd) {
    session.cwd = facts.cwd
  }
  if (facts.ts !== null) {
    session.firstTs = session.firstTs === null ? facts.ts : Math.min(session.firstTs, facts.ts)
    session.lastTs = session.lastTs === null ? facts.ts : Math.max(session.lastTs, facts.ts)
  }
  if (facts.links) {
    rememberLinks(session, facts.links)
  }
  for (const record of records) {
    if (record.role === 'user') {
      session.userTurns += 1
      if (session.firstAsk === null) {
        session.firstAsk = cap(record.text, ASK_CAP)
        session.kind = isSidecarAsk(record.text) ? 'sidecar' : 'work'
      }
      session.lastAsk = cap(record.text, ASK_CAP)
      rememberLinks(session, extractLinks(record.text))
    } else if (record.role === 'assistant') {
      session.lastAnswer = record.text.slice(0, ANSWER_CAP * 2)
      rememberLinks(session, extractLinks(record.text))
    }
  }
}

function cheapHash(text: string): string {
  let hash = 2166136261
  const sample = text.length > 400 ? text.slice(0, 200) + text.slice(-200) : text
  for (let i = 0; i < sample.length; i++) {
    hash ^= sample.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

function splitText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) {
    return [text]
  }
  const pieces: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > start + CHUNK_CHARS / 2) {
        end = space
      }
    }
    pieces.push(text.slice(start, end))
    start = end
  }
  return pieces
}

/** Redact, de-duplicate repeated tool output and cut records into index chunks. */
export function recordsToChunks(
  records: readonly TranscriptSearchRecord[],
  seenToolOutput: Set<string>
): { chunks: IndexChunk[]; redacted: TranscriptSearchRecord[] } {
  const chunks: IndexChunk[] = []
  const redacted: TranscriptSearchRecord[] = []
  for (const record of records) {
    const text = redactTranscriptText(record.text)
    if (record.role === 'tool') {
      const key = cheapHash(text)
      if (seenToolOutput.has(key)) {
        continue
      }
      seenToolOutput.add(key)
    }
    redacted.push({ ...record, text })
    for (const piece of splitText(text)) {
      chunks.push({
        role: record.role,
        text: piece,
        ts: record.ts,
        ...(record.output ? { output: true as const } : {})
      })
    }
  }
  return { chunks, redacted }
}

// The agent's own status line in its last reply ("State: …", "**Status** — …", "Where it stands: …").
const STATE_LINE =
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:state|status|where (?:it|this|things) stands?)(?:\*\*)?\s*[:—–-]\s*(.+)/i
const STATE_CHARS = 220
const HAS_STATE_LINE = /(?:^|\n)State:/

/**
 * Where the work stands, in the agent's own last words: its status line, else its closing
 * paragraph. The omnios Work feed reads done / open / blocked from this line alone.
 */
export function endedState(answer: string | null): string {
  const text = answer?.trim()
  if (!text) {
    return "Waiting for the agent's first reply"
  }
  const line = STATE_LINE.exec(text)
  if (line) {
    return cap(line[1]!.replace(/\*\*/g, ''), STATE_CHARS)
  }
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim())
  return cap(paragraphs.at(-1) ?? text, STATE_CHARS)
}

/** Every summary carries a State line; one written without it gets the agent's own last words. */
export function withStateLine(summary: string, lastAnswer: string | null): string {
  return HAS_STATE_LINE.test(summary) ? summary : `${summary}\nState: ${endedState(lastAnswer)}`
}

function nextAction(answer: string | null): string | null {
  const match = answer ? NEXT_LINE.exec(answer) : null
  return match ? cap(match[1]!, 220) : null
}

/** The summary that exists without any model: goal, latest ask, where it ended, outputs. */
export function buildExtractiveSummary(session: SessionRow): string {
  const lines: string[] = []
  if (session.firstAsk) {
    lines.push(`Goal: ${cap(session.firstAsk, 240)}`)
  }
  // Why second: a summary over the limit is cut at its end, and State is what the Work feed reads.
  lines.push(`State: ${endedState(session.lastAnswer)}`)
  if (session.lastAsk && session.lastAsk !== session.firstAsk) {
    lines.push(`Latest ask: ${cap(session.lastAsk, 200)}`)
  }
  if (session.lastAnswer) {
    lines.push(`Where it ended: ${cap(session.lastAnswer, 260)}`)
  }
  const next = nextAction(session.lastAnswer)
  if (next) {
    lines.push(`Next: ${next}`)
  }
  const links = session.links.slice(-6).toReversed()
  if (links.length > 0) {
    lines.push(`Outputs: ${links.join(' ')}`)
  }
  if (session.cwd) {
    lines.push(`Folder: ${session.cwd}`)
  }
  const text = lines.join('\n')
  return text.length > EXTRACTIVE_SUMMARY_MAX_CHARS
    ? `${text.slice(0, EXTRACTIVE_SUMMARY_MAX_CHARS - 1)}…`
    : text
}
