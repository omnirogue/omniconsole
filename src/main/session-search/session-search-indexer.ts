import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { IndexedFileRow, SessionSearchIndex, SessionRow } from './session-search-index'
import { applyLineFacts, buildExtractiveSummary, recordsToChunks } from './session-search-facts'
import { readTranscriptLine } from './transcript-search-records'
import type { TranscriptFile } from './session-search-roots'
import { embeddingToBlob, type StaticEmbeddingModel } from './session-search-embedding'

const READ_SLICE_BYTES = 1024 * 1024
/** Cap one line: a pasted image or a giant tool result is not worth a parse. */
const MAX_LINE_BYTES = 4 * 1024 * 1024
const SEEN_OUTPUT_SESSIONS = 64
const PREFIX_PROBE_BYTES = 64 * 1024

export type IndexerThrottle = {
  /** Fraction of wall time the indexer may spend working (0–1). */
  dutyCycle: number
  sleep(ms: number): Promise<void>
}

export type FileIndexOutcome = 'unchanged' | 'indexed' | 'reset'

/** True when `next` holds the same bytes as `indexed` up to `length`, judged by its head and tail. */
async function sharesIndexedPrefix(
  indexed: string,
  next: string,
  length: number
): Promise<boolean> {
  if (length === 0) {
    return true
  }
  const probe = Math.min(PREFIX_PROBE_BYTES, length)
  const read = async (path: string): Promise<Buffer | null> => {
    try {
      const handle = await open(path, 'r')
      try {
        const bytes = Buffer.alloc(probe * 2)
        const head = await handle.read(bytes, 0, probe, 0)
        const tail = await handle.read(bytes, probe, probe, length - probe)
        return head.bytesRead === probe && tail.bytesRead === probe ? bytes : null
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }
  const [a, b] = await Promise.all([read(indexed), read(next)])
  return a !== null && b !== null && a.equals(b)
}

/** How the embedding text for a session is formed; shared by indexing and model summaries. */
export function sessionEmbeddingText(session: SessionRow, summary: string): string {
  return [session.title ?? '', summary].join('\n')
}

export class SessionSearchIndexer {
  private readonly seenToolOutput = new Map<number, Set<string>>()

  constructor(
    private readonly index: SessionSearchIndex,
    private readonly model: StaticEmbeddingModel | null,
    private readonly throttle: IndexerThrottle
  ) {}

  private seenFor(sid: number): Set<string> {
    let seen = this.seenToolOutput.get(sid)
    if (seen) {
      this.seenToolOutput.delete(sid)
    } else {
      seen = new Set()
    }
    this.seenToolOutput.set(sid, seen)
    while (this.seenToolOutput.size > SEEN_OUTPUT_SESSIONS) {
      this.seenToolOutput.delete(this.seenToolOutput.keys().next().value!)
    }
    return seen
  }

  /** Index whatever was appended to `file` since the last pass. */
  async indexFile(listed: TranscriptFile, signal?: AbortSignal): Promise<FileIndexOutcome> {
    const sessionKey = `${listed.agent}:${listed.sessionId}`
    const existing = this.index.sessionByKey(sessionKey)
    // Why: Codex rollouts are hardlinked into every account home; reading through the alias
    // already indexed keeps a newly bridged link from looking like a different file.
    const file =
      existing && existing.path !== listed.path && listed.aliases?.includes(existing.path)
        ? { ...listed, path: existing.path }
        : listed
    const known = this.index.getFile(file.path)
    if (
      known &&
      known.size === file.size &&
      Math.round(known.mtimeMs) === Math.round(file.mtimeMs)
    ) {
      return 'unchanged'
    }
    const session = this.index.ensureSession({
      sessionKey,
      agent: file.agent,
      sessionId: file.sessionId,
      path: file.path
    })
    const resumeAt = await this.resumeOffset(existing, known, file)
    let offset = resumeAt ?? 0
    let outcome: FileIndexOutcome = 'indexed'
    if (resumeAt === null && existing) {
      // Rewritten, or replaced by a file that does not continue the indexed one: start over.
      this.index.transaction(() => this.index.resetSession(session.sid))
      Object.assign(session, this.index.sessionByKey(session.sessionKey))
      outcome = 'reset'
    }
    session.path = file.path
    const handle = await open(file.path, 'r')
    try {
      const seen = this.seenFor(session.sid)
      const decoder = new StringDecoder('utf8')
      // Text after the last newline: a line still being written, never indexed until complete.
      let pending = ''
      let readAt = offset
      let recorded = false
      while (readAt < file.size && !signal?.aborted) {
        const started = performance.now()
        const slice = Buffer.alloc(Math.min(READ_SLICE_BYTES, file.size - readAt))
        const { bytesRead } = await handle.read(slice, 0, slice.length, readAt)
        if (bytesRead === 0) {
          break
        }
        readAt += bytesRead
        const text = pending + decoder.write(slice.subarray(0, bytesRead))
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline === -1) {
          pending = text
          if (pending.length > MAX_LINE_BYTES) {
            // A pasted image or giant tool result: skip the line rather than hold it in memory.
            offset += Buffer.byteLength(pending)
            pending = ''
          }
          continue
        }
        const complete = text.slice(0, lastNewline + 1)
        pending = text.slice(lastNewline + 1)
        const finished = readAt >= file.size
        this.index.transaction(() => {
          this.consumeLines(session, complete, seen)
          offset += Buffer.byteLength(complete)
          this.index.saveSessionFacts(session)
          // Why: size and mtime are recorded only once the whole file is read, so an
          // interrupted pass resumes from `offset` instead of believing it finished.
          this.index.putFile({
            path: file.path,
            sid: session.sid,
            size: finished ? file.size : offset,
            mtimeMs: finished ? file.mtimeMs : 0,
            offset
          })
        })
        recorded = finished
        this.index.writes.roll()
        await this.pause(performance.now() - started)
      }
      if (!recorded && readAt >= file.size && !signal?.aborted) {
        // Why: an empty file, or one with no complete line yet, was re-read and rewritten every pass.
        this.index.putFile({
          path: file.path,
          sid: session.sid,
          size: file.size,
          mtimeMs: file.mtimeMs,
          offset
        })
      }
    } finally {
      await handle.close()
    }
    this.refreshExtractiveSummary(session)
    return outcome
  }

  /**
   * Where reading `file` picks up: the indexed offset when `file` continues what the session was
   * indexed from, `null` when it must be re-read from the start, 0 for a brand-new session.
   */
  private async resumeOffset(
    existing: SessionRow | null,
    known: IndexedFileRow | null,
    file: TranscriptFile
  ): Promise<number | null> {
    if (!existing) {
      return 0
    }
    const samePath = existing.path === file.path
    const basis = samePath ? known : this.index.getFile(existing.path)
    if (!basis && samePath && existing.nextSeq === 0) {
      return 0
    }
    if (!basis || basis.sid !== existing.sid || basis.offset > file.size) {
      return null
    }
    // Why: a copy that continues the indexed transcript (an account switch) resumes, not re-indexes.
    return samePath || (await sharesIndexedPrefix(existing.path, file.path, basis.offset))
      ? basis.offset
      : null
  }

  private consumeLines(session: SessionRow, text: string, seen: Set<string>): void {
    for (const line of text.split('\n')) {
      if (line.length > MAX_LINE_BYTES) {
        continue
      }
      const facts = readTranscriptLine(session.agent, line)
      if (!facts) {
        continue
      }
      const { chunks, redacted } = recordsToChunks(facts.records, seen)
      applyLineFacts(session, facts, redacted)
      if (chunks.length > 0) {
        this.index.appendChunks(session, chunks)
      }
    }
  }

  /** Keeps the extractive summary current; a model summary, once written, is left in place. */
  private refreshExtractiveSummary(session: SessionRow): void {
    const fresh = this.index.sessionByKey(session.sessionKey)
    if (!fresh || fresh.summarySource === 'model') {
      return
    }
    const summary = buildExtractiveSummary(fresh)
    if (!summary || (summary === fresh.summary && fresh.summarySource === 'extractive')) {
      return
    }
    const embedding = this.model
      ? embeddingToBlob(this.model.embed(sessionEmbeddingText(fresh, summary)))
      : null
    this.index.transaction(() => this.index.saveSummary(fresh, summary, 'extractive', embedding))
  }

  private async pause(workedMs: number): Promise<void> {
    const duty = Math.min(1, Math.max(0.05, this.throttle.dutyCycle))
    const rest = (workedMs * (1 - duty)) / duty
    await this.throttle.sleep(Math.max(1, Math.round(rest)))
  }
}
