import { basename } from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { UsageScanOptions } from '../usage/usage-provider-contract'
import { UsageScanStoppedError } from '../usage/usage-scan-stopped-error'
import {
  canonicalizePath,
  getLegacySourceSkipBytesByPath,
  listCodexSessionFiles,
  yieldToEventLoop
} from './codex-session-file-discovery'
import {
  attributeCodexUsageEvent,
  createCodexUsageWorktreeResolver,
  getCodexUsageCwdAttribution,
  type CodexUsageWorktreeRef,
  type CodexUsageWorktreeResolver
} from './codex-usage-event-attribution'
import { parseCodexUsageRecord, type CodexUsageParseContext } from './codex-usage-record-parser'
import type {
  CodexUsageAttributedEvent,
  CodexUsageDailyAggregate,
  CodexUsagePersistedFile,
  CodexUsageProcessedFile,
  CodexUsageSession
} from './types'

const YIELD_EVERY_FILES = 10
const CHECKPOINT_INTERVAL_MS = 2 * 60_000

export async function getProcessedFileInfo(filePath: string): Promise<CodexUsageProcessedFile> {
  const fileStat = await stat(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size
  }
}

async function buildWorktreesWithCanonicalPaths(
  worktrees: CodexUsageWorktreeRef[]
): Promise<(CodexUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

type CodexUsageMetric = { hasInferredPricing: boolean }

const codexUsageAggregation = createUsageEventAggregation<
  CodexUsageAttributedEvent,
  CodexUsageMetric
>({
  metric: {
    empty: () => ({ hasInferredPricing: false }),
    fromEvent: (event) => ({ hasInferredPricing: event.hasInferredPricing }),
    fold: (target, source) => {
      target.hasInferredPricing ||= source.hasInferredPricing
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  codexUsageAggregation

export async function parseCodexUsageFile(
  filePath: string,
  worktrees: (CodexUsageWorktreeRef & { canonicalPath: string })[] | CodexUsageWorktreeResolver,
  options: { skipInitialBytes?: number; claimEventKey?: (eventKey: string) => boolean } = {}
): Promise<CodexUsagePersistedFile> {
  const processedFile = await getProcessedFileInfo(filePath)
  const lines = createInterface({
    input: createReadStream(filePath, {
      encoding: 'utf-8',
      start: options.skipInitialBytes ?? 0
    }),
    crlfDelay: Infinity
  })
  const events: CodexUsageAttributedEvent[] = []
  const context: CodexUsageParseContext = {
    sessionId: basename(filePath, '.jsonl'),
    sessionCwd: null,
    currentCwd: null,
    currentModel: null,
    previousTotals: null,
    // Why: suffix-only legacy copy parsing lacks the copied prefix context. A
    // leading total-only snapshot is a baseline, not the suffix's billable delta.
    totalOnlyBaselinePending: (options.skipInitialBytes ?? 0) > 0
  }

  const resolveWorktree =
    typeof worktrees === 'function' ? worktrees : createCodexUsageWorktreeResolver(worktrees)
  const attributionByCwd: Record<string, string | null> = {}
  const ownedEventKeys = new Set<string>()
  let hasDeferredClaims = false
  for await (const line of lines) {
    const parsed = parseCodexUsageRecord(line, context)
    if (!parsed) {
      continue
    }
    // Why: fork/resume rollouts start with a copied prefix of the parent file.
    // Events another file already owns are dropped here, but the record still
    // advanced context.previousTotals above, so later deltas stay correct.
    if (options.claimEventKey && !options.claimEventKey(parsed.eventKey)) {
      hasDeferredClaims = true
      continue
    }
    ownedEventKeys.add(parsed.eventKey)
    if (parsed.cwd && !Object.hasOwn(attributionByCwd, parsed.cwd)) {
      attributionByCwd[parsed.cwd] = getCodexUsageCwdAttribution(resolveWorktree(parsed.cwd))
    }
    const attributed = await attributeCodexUsageEvent(parsed, resolveWorktree)
    if (attributed) {
      events.push(attributed)
    }
  }

  return {
    ...processedFile,
    ...codexUsageAggregation.aggregate(events),
    ownedEventKeys: [...ownedEventKeys],
    hasDeferredClaims,
    attributionByCwd
  }
}

/**
 * Whether a cached file's worktree attribution still holds. A file recorded with its cwds is checked
 * cwd by cwd, so adding or removing an unrelated worktree keeps it. An older cache entry has no such
 * record and is trusted only while the worktree list is unchanged.
 */
function cachedAttributionStillHolds(
  previous: CodexUsagePersistedFile,
  resolveWorktree: CodexUsageWorktreeResolver,
  worktreeSetChanged: boolean
): boolean {
  const attributionByCwd = previous.attributionByCwd
  if (!attributionByCwd || typeof attributionByCwd !== 'object') {
    return !worktreeSetChanged
  }
  for (const [cwd, attribution] of Object.entries(attributionByCwd)) {
    if (getCodexUsageCwdAttribution(resolveWorktree(cwd)) !== attribution) {
      return false
    }
  }
  return true
}

export async function scanCodexUsageFiles(
  worktrees: CodexUsageWorktreeRef[],
  previousProcessedFiles: CodexUsagePersistedFile[],
  options: UsageScanOptions<CodexUsagePersistedFile> = {}
): Promise<{
  processedFiles: CodexUsagePersistedFile[]
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
}> {
  if (options.shouldStop?.()) {
    throw new UsageScanStoppedError('Codex usage scan stopped')
  }
  const files = await listCodexSessionFiles()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const resolveWorktree = createCodexUsageWorktreeResolver(
    await buildWorktreesWithCanonicalPaths(worktrees)
  )
  const legacySourceSkipBytesByPath = getLegacySourceSkipBytesByPath(files)

  const currentPaths = new Set(files)
  // Why: when a rollout that owned event keys is deleted, remaining forks still
  // contain those records but their caches record them as unowned. Only files
  // that previously deferred claims can reclaim, so invalidate those — not the
  // entire rollout corpus.
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedEventKeys) &&
      file.ownedEventKeys.length > 0
  )

  const reusedByPath = new Map<string, CodexUsagePersistedFile>()
  const pathsToParse: string[] = []
  for (const [index, filePath] of files.entries()) {
    if (options.shouldStop?.()) {
      throw new UsageScanStoppedError('Codex usage scan stopped')
    }
    const legacySourceSkipBytes = legacySourceSkipBytesByPath.get(filePath) ?? 0
    const fileInfo = await getProcessedFileInfo(filePath)
    const previous = previousByPath.get(filePath)
    // When an owner disappears, only deferred-claim files need reparse.
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      legacySourceSkipBytes === 0 &&
      previous &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      Array.isArray(previous.ownedEventKeys) &&
      typeof previous.hasDeferredClaims === 'boolean' &&
      cachedAttributionStillHolds(previous, resolveWorktree, options.worktreeSetChanged === true)
    if (canReuse) {
      reusedByPath.set(filePath, previous)
    } else {
      pathsToParse.push(filePath)
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  // Why: resuming or forking a Codex session copies the parent rollout's
  // token_count records into a new file, so per-file parsing re-counts the
  // whole copied history once per descendant (#8006). Cross-file ownership
  // counts each record for exactly one file; cached files keep the claims
  // they persisted, and new files claim in sorted-path order so rescans stay
  // deterministic.
  const eventOwnerByKey = new Map<string, string>()
  for (const [filePath, previous] of reusedByPath) {
    for (const eventKey of previous.ownedEventKeys) {
      // First cached claim wins so conflicting projections stay deterministic.
      if (!eventOwnerByKey.has(eventKey)) {
        eventOwnerByKey.set(eventKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, CodexUsagePersistedFile>()
  const settledFiles = (): CodexUsagePersistedFile[] =>
    files.flatMap((filePath) => {
      const settled = reusedByPath.get(filePath) ?? parsedByPath.get(filePath)
      return settled ? [settled] : []
    })
  let lastCheckpointAt = Date.now()
  for (const [index, filePath] of pathsToParse.entries()) {
    if (options.shouldStop?.()) {
      throw new UsageScanStoppedError('Codex usage scan stopped')
    }
    const processed = await parseCodexUsageFile(filePath, resolveWorktree, {
      skipInitialBytes: legacySourceSkipBytesByPath.get(filePath) ?? 0,
      claimEventKey: (eventKey) => {
        const owner = eventOwnerByKey.get(eventKey)
        if (owner !== undefined && owner !== filePath) {
          return false
        }
        eventOwnerByKey.set(eventKey, filePath)
        return true
      }
    })
    parsedByPath.set(filePath, processed)
    // Why: a first scan of a large history can outlast the app session; checkpoints let the next
    // launch resume from the files already parsed instead of starting over (#857).
    if (options.onCheckpoint && Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      lastCheckpointAt = Date.now()
      await options.onCheckpoint(settledFiles()).catch(() => {})
    }

    // Allow worker messages and cancellation checks between parsing batches.
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const processedFiles = settledFiles()
  const sessionsById = new Map<string, CodexUsageSession>()
  const dailyByKey = new Map<string, CodexUsageDailyAggregate>()
  for (const processed of processedFiles) {
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}
