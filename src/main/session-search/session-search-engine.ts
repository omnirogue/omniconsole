import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SessionSearchHit } from '../../shared/session-search-types'
import {
  embeddingFromBlob,
  embeddingToBlob,
  loadStaticEmbeddingModel,
  type StaticEmbeddingModel
} from './session-search-embedding'
import { SessionSearchIndex, type SessionRow } from './session-search-index'
import { withStateLine } from './session-search-facts'
import { SessionSearchIndexer, sessionEmbeddingText } from './session-search-indexer'
import { planSessionSearchQuery } from './session-search-query'
import { rankSessions } from './session-search-ranking'
import { discoverTranscriptRoots, listTranscriptFiles } from './session-search-roots'
import type {
  SessionSearchFeedRow,
  SessionSearchServiceInit,
  SessionSearchServiceRequest,
  SessionSearchServiceStatus,
  SessionSearchSummaryCandidate
} from './session-search-service-protocol'
import {
  buildSessionDigest,
  buildSessionSummaryPrompt,
  normalizeModelSummary,
  sessionSummaryTitle,
  withRecordedLinks
} from './session-summary-prompt'
import { readTranscriptOrigin, type TranscriptOrigin } from './transcript-origin'

const FEED_TEXT_CHARS = 600

function clip(text: string | null): string | null {
  return text && text.length > FEED_TEXT_CHARS ? `${text.slice(0, FEED_TEXT_CHARS - 1)}…` : text
}

export function createSessionSearchEngine(init: SessionSearchServiceInit) {
  let config: SessionSearchServiceInit | null = null
  let index: SessionSearchIndex | null = null
  let indexer: SessionSearchIndexer | null = null
  let model: StaticEmbeddingModel | null = null
  let embeddings: Map<number, Float32Array> | null = null
  let stopped = false
  let wake: (() => void) | null = null
  // A transcript's origin never changes; read its head once per file.
  const origins = new Map<string, { path: string; origin: TranscriptOrigin }>()
  // Why: `lastConversationTs` scans the session's FTS5 chunk range; cache by `(lastTs, textBytes)`.
  const conversationTsCache = new Map<number, { key: string; ts: number | null }>()
  const status: SessionSearchServiceStatus = {
    indexedSessions: 0,
    pendingFiles: 0,
    passes: 0,
    lastPassAt: null,
    modelLoaded: false
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })

  function loadEmbeddings(): Map<number, Float32Array> {
    if (!embeddings && index) {
      embeddings = new Map()
      for (const { sid, blob } of index.embeddings()) {
        const vector = embeddingFromBlob(blob)
        if (vector) {
          embeddings.set(sid, vector)
        }
      }
    }
    return embeddings ?? new Map()
  }

  async function indexingLoop(): Promise<void> {
    while (!stopped && config && index && indexer) {
      try {
        const roots = await discoverTranscriptRoots({
          homeDir: config.homeDir,
          appDataDirs: config.appDataDirs
        })
        const files = await listTranscriptFiles(roots)
        status.pendingFiles = files.length
        let changed = false
        const duty = Math.min(1, Math.max(0.05, config.dutyCycle))
        let sliceStarted = performance.now()
        index.writes.begin()
        try {
          for (const file of files) {
            if (stopped) {
              return
            }
            try {
              const fileChanged = (await indexer.indexFile(file)) !== 'unchanged'
              changed = fileChanged || changed
              sliceStarted = fileChanged ? performance.now() : sliceStarted
            } catch (error) {
              process.stderr.write(`[session-search] ${file.path}: ${String(error)}\n`)
            }
            status.pendingFiles -= 1
            index?.writes.roll()
            const workedMs = performance.now() - sliceStarted
            if (duty < 1 && workedMs >= 15) {
              await sleep(Math.max(1, Math.round((workedMs * (1 - duty)) / duty)))
              sliceStarted = performance.now()
            }
          }
        } finally {
          index?.writes.end()
        }
        if (changed) {
          embeddings = null
        }
        status.indexedSessions = index.counts().sessions
        status.passes += 1
        status.lastPassAt = Date.now()
      } catch (error) {
        process.stderr.write(`[session-search] pass failed: ${String(error)}\n`)
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        void sleep(config?.passIntervalMs ?? 90_000).then(resolve)
      })
      wake = null
    }
  }

  function toHit(entry: ReturnType<typeof rankSessions>[number]): SessionSearchHit {
    const session = entry.session
    return {
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      agent: session.agent,
      hostLabel: config?.hostLabel ?? 'this computer',
      executionHostId: 'local',
      // Why `||`: an empty stored title must still show something a person recognizes.
      title:
        session.title?.trim() ||
        session.firstAsk?.replace(/\s+/g, ' ').trim().slice(0, 120) ||
        session.sessionId,
      cwd: session.cwd,
      transcriptPath: session.path,
      lastActivityAt: session.lastTs,
      score: Math.round(entry.score * 100) / 100,
      match: entry.match,
      reasons: entry.reasons,
      snippets: entry.snippets,
      summary: session.summary,
      summarySource: session.summarySource
    }
  }

  function summaryCandidates(args: {
    limit: number
    minBytes: number
    activeSinceMs: number
    idleBeforeMs?: number
  }): SessionSearchSummaryCandidate[] {
    if (!index) {
      return []
    }
    const fence = randomBytes(8).toString('hex')
    return index
      .sessionsNeedingModelSummary({
        limit: args.limit,
        minBytes: args.minBytes,
        idleBefore: args.idleBeforeMs,
        activeSince: args.activeSinceMs
      })
      .map((session: SessionRow) => ({
        sessionKey: session.sessionKey,
        basisBytes: session.textBytes,
        prompt: buildSessionSummaryPrompt(
          buildSessionDigest(session, index!.conversationTurns(session.sid)),
          fence
        )
      }))
  }

  function saveModelSummary(sessionKey: string, raw: string, basisBytes: number): boolean {
    const session = index?.sessionByKey(sessionKey)
    const normalized = normalizeModelSummary(raw)
    if (!index || !session || !normalized) {
      return false
    }
    // A missing/invalid name is recorded once so legacy backfill cannot monopolize the queue.
    const titled = /^Title:/m.test(normalized) ? normalized : `Title: unknown\n${normalized}`
    const summary = withRecordedLinks(withStateLine(titled, session.lastAnswer), session.links)
    const vector = model?.embed(sessionEmbeddingText(session, summary)) ?? null
    // Why: the basis is what the model read, not what has been indexed since it was asked.
    session.textBytes = Math.min(session.textBytes, basisBytes)
    index.transaction(() =>
      index!.saveSummary(session, summary, 'model', vector ? embeddingToBlob(vector) : null)
    )
    if (vector) {
      loadEmbeddings().set(session.sid, vector)
    }
    return true
  }

  function feedRows(args: { sinceMs: number; limit: number }): SessionSearchFeedRow[] {
    const current = index
    if (!current) {
      return []
    }
    return current
      .sessionsActiveSince(args.sinceMs, Math.min(Math.max(1, args.limit), 10_000))
      .map((session) => {
        let known = origins.get(session.sessionKey)
        if (!known || known.path !== session.path) {
          known = { path: session.path, origin: readTranscriptOrigin(session.path, session.agent) }
          origins.set(session.sessionKey, known)
        }
        const tsKey = `${session.lastTs ?? 0}:${session.textBytes}`
        let cachedTs = conversationTsCache.get(session.sid)
        if (!cachedTs || cachedTs.key !== tsKey) {
          cachedTs = { key: tsKey, ts: current.lastConversationTs(session.sid) }
          conversationTsCache.set(session.sid, cachedTs)
        }
        return {
          sessionKey: session.sessionKey,
          agent: session.agent,
          sessionId: session.sessionId,
          title: session.title,
          cwd: session.cwd,
          firstTs: session.firstTs,
          lastTs: cachedTs.ts ?? session.lastTs,
          userTurns: session.userTurns,
          textBytes: session.textBytes,
          firstAsk: clip(session.firstAsk),
          lastAnswer: clip(session.lastAnswer),
          links: session.links,
          // Why: summaries written before every one carried a State line still post a status.
          summary: session.summary ? withStateLine(session.summary, session.lastAnswer) : null,
          summarySource: session.summarySource,
          origin: known.origin
        }
      })
  }

  function execute(request: SessionSearchServiceRequest): unknown {
    switch (request.op) {
      case 'search': {
        const ranked = index
          ? rankSessions(index, planSessionSearchQuery(request.query), {
              limit: request.limit,
              now: Date.now(),
              model,
              embeddings: loadEmbeddings(),
              queryText: request.query
            })
          : []
        return { hits: ranked.map(toHit), ...status }
      }
      case 'status':
        return { ...status }
      case 'sessionLinks':
        return index?.sessionByKey(request.sessionKey)?.links ?? null
      case 'summaryCandidates':
        return summaryCandidates(request)
      case 'saveModelSummary':
        return saveModelSummary(request.sessionKey, request.summary, request.basisBytes)
      case 'feedRows':
        return feedRows(request)
      case 'summaryTitles':
        return Object.fromEntries(
          request.sessionKeys.slice(0, 1_000).flatMap((key) => {
            const session = index?.sessionByKey(key)
            if (
              !session?.summary ||
              session.summarySource !== 'model' ||
              session.summaryBasisBytes !== session.textBytes
            ) {
              return []
            }
            const title = sessionSummaryTitle(session.summary)
            return title ? [[key, title]] : []
          })
        )
    }
  }

  function start(init: SessionSearchServiceInit): void {
    config = init
    mkdirSync(dirname(init.dbPath), { recursive: true, mode: 0o700 })
    index = new SessionSearchIndex(init.dbPath)
    model = loadStaticEmbeddingModel(init.modelDir)
    status.modelLoaded = model !== null
    status.indexedSessions = index.counts().sessions
    indexer = new SessionSearchIndexer(index, model, { dutyCycle: init.dutyCycle, sleep })
    void indexingLoop()
  }

  function shutdown(): void {
    stopped = true
    wake?.()
    try {
      index?.writes.end()
      index?.close()
    } catch {
      // Closing during a pending write only loses that write; the next start re-reads the file.
    }
    index = null
  }

  start(init)
  return { execute, shutdown }
}
