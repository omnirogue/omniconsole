import { existsSync, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { listCodexSessionRolloutFilesIncrementally } from './codex-session-file-listing'
import type {
  CodexSessionBridgeIncrementalOptions,
  CodexSessionDirectoryReuse
} from './codex-session-file-listing'
import { linkCodexSessionFile } from './codex-session-link'

/**
 * Bridges Codex history between OmniConsole-managed Codex homes.
 *
 * Why: a managed account launches Codex against its own self-contained
 * CODEX_HOME, and Codex's `/resume` picker only lists rollouts under that home.
 * Without this, switching accounts hides every conversation the user recorded
 * under a different account (or under their real ~/.codex). Rollouts are
 * hardlinked, so each conversation stays one physical log no matter how many
 * homes list it.
 */

export type CodexAccountSessionBridgeSummary = {
  scannedFiles: number
  linkedFiles: number
}

const backgroundBridgeTasksByTargetHome = new Map<string, Promise<void>>()

type BridgedDirectory = {
  sourceMtimeMs: number
  targetMtimeMs: number | null
  childDirectoryNames: readonly string[]
}

type ListedDirectory = Omit<BridgedDirectory, 'targetMtimeMs'> & {
  sourcePath: string
  targetPath: string
}

/**
 * Source directories already mirrored into each target home. Why: every launch re-checked every
 * rollout of every other home on the main thread — about 150k `existsSync` calls here (#857).
 */
const bridgedDirectoriesByTargetHome = new Map<string, Map<string, BridgedDirectory>>()

// Why: an entry can still land inside the mtime tick a recently modified directory was read in.
const SETTLED_DIRECTORY_AGE_MS = 2_000

/**
 * Starts one background bridge per target home, sharing in-flight work.
 */
export function startCodexAccountSessionBridgeInBackground(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  options?: CodexSessionBridgeIncrementalOptions
}): Promise<void> {
  const key = normalizeRuntimePathForComparison(args.targetCodexHomePath)
  const inFlight = backgroundBridgeTasksByTargetHome.get(key)
  if (inFlight) {
    return inFlight
  }
  const task = bridgeCodexSessionsIntoAccountHome(args)
    .catch((error: unknown) => {
      console.warn('[codex-account-session-bridge] Background session bridge failed:', error)
    })
    .then(() => undefined)
  backgroundBridgeTasksByTargetHome.set(key, task)
  void task.finally(() => {
    if (backgroundBridgeTasksByTargetHome.get(key) === task) {
      backgroundBridgeTasksByTargetHome.delete(key)
    }
  })
  return task
}

/**
 * Mirrors every source home's rollouts into the target home's sessions tree.
 */
export async function bridgeCodexSessionsIntoAccountHome(args: {
  targetCodexHomePath: string
  sourceCodexHomePaths: readonly string[]
  options?: CodexSessionBridgeIncrementalOptions
}): Promise<CodexAccountSessionBridgeSummary> {
  const summary: CodexAccountSessionBridgeSummary = { scannedFiles: 0, linkedFiles: 0 }
  const targetSessionsRoot = join(args.targetCodexHomePath, 'sessions')
  const targetKey = normalizeRuntimePathForComparison(args.targetCodexHomePath)
  const bridged =
    bridgedDirectoriesByTargetHome.get(targetKey) ?? new Map<string, BridgedDirectory>()
  bridgedDirectoriesByTargetHome.set(targetKey, bridged)
  const listed: ListedDirectory[] = []
  for (const sourceHomePath of dedupeSourceHomes(
    args.sourceCodexHomePaths,
    args.targetCodexHomePath
  )) {
    const sourceSessionsRoot = join(sourceHomePath, 'sessions')
    if (!existsSync(sourceSessionsRoot)) {
      continue
    }
    const unlinkedDirectories = new Set<string>()
    for await (const sourceFilePath of listCodexSessionRolloutFilesIncrementally(
      sourceSessionsRoot,
      {
        ...args.options,
        directoryReuse: reuseBridgedDirectories(
          bridged,
          listed,
          unlinkedDirectories,
          (sourceDirectory) =>
            join(targetSessionsRoot, relative(sourceSessionsRoot, sourceDirectory))
        )
      }
    )) {
      summary.scannedFiles += 1
      const outcome = bridgeRolloutIntoAccountHome(
        sourceSessionsRoot,
        targetSessionsRoot,
        sourceFilePath
      )
      if (outcome === 'linked') {
        summary.linkedFiles += 1
      } else if (outcome === 'failed') {
        unlinkedDirectories.add(dirname(sourceFilePath))
      }
    }
  }
  // Why after every source: several homes link into the same mirror directory, so a mtime read
  // mid-run would already be stale and make the next launch list those directories again.
  for (const directory of listed) {
    bridged.set(directory.sourcePath, {
      sourceMtimeMs: directory.sourceMtimeMs,
      targetMtimeMs: await readDirectoryMtimeMs(directory.targetPath),
      childDirectoryNames: directory.childDirectoryNames
    })
  }
  return summary
}

/**
 * Skips a source directory while neither it nor its mirror changed since it was fully linked.
 * A directory's mtime moves whenever an entry is added or removed, in either tree.
 */
function reuseBridgedDirectories(
  bridged: Map<string, BridgedDirectory>,
  listed: ListedDirectory[],
  unlinkedDirectories: ReadonlySet<string>,
  targetDirectoryFor: (sourceDirectory: string) => string
): CodexSessionDirectoryReuse {
  const listing = new Map<string, number>()
  return {
    unchangedChildDirectories: async (sourceDirectory) => {
      const sourceMtimeMs = await readDirectoryMtimeMs(sourceDirectory)
      const known = bridged.get(sourceDirectory)
      if (
        sourceMtimeMs !== null &&
        known?.sourceMtimeMs === sourceMtimeMs &&
        known.targetMtimeMs === (await readDirectoryMtimeMs(targetDirectoryFor(sourceDirectory)))
      ) {
        return known.childDirectoryNames
      }
      bridged.delete(sourceDirectory)
      // Read before the listing, so an entry added while it runs shows up as a change next time.
      if (sourceMtimeMs !== null) {
        listing.set(sourceDirectory, sourceMtimeMs)
      }
      return null
    },
    onDirectoryListed: async (sourceDirectory, childDirectoryNames) => {
      const sourceMtimeMs = listing.get(sourceDirectory)
      listing.delete(sourceDirectory)
      if (
        sourceMtimeMs === undefined ||
        sourceMtimeMs > Date.now() - SETTLED_DIRECTORY_AGE_MS ||
        // A rollout that could not be linked is retried on the next launch, as before.
        unlinkedDirectories.has(sourceDirectory)
      ) {
        return
      }
      listed.push({
        sourcePath: sourceDirectory,
        targetPath: targetDirectoryFor(sourceDirectory),
        sourceMtimeMs,
        childDirectoryNames
      })
    }
  }
}

async function readDirectoryMtimeMs(directoryPath: string): Promise<number | null> {
  try {
    return (await stat(directoryPath)).mtimeMs
  } catch {
    return null
  }
}

/**
 * Links one rollout into the target sessions tree at the same relative path.
 */
function bridgeRolloutIntoAccountHome(
  sourceSessionsRoot: string,
  targetSessionsRoot: string,
  sourceFilePath: string
): 'linked' | 'present' | 'failed' {
  const targetFilePath = join(targetSessionsRoot, relative(sourceSessionsRoot, sourceFilePath))
  // Why: rollout names carry the session UUID, so an existing target path is the
  // same conversation already bridged (often the same inode) — never a conflict.
  if (existsSync(targetFilePath)) {
    return 'present'
  }
  try {
    mkdirSync(dirname(targetFilePath), { recursive: true })
  } catch (error) {
    console.warn('[codex-account-session-bridge] Failed to create session directory:', error)
    return 'failed'
  }
  return linkCodexSessionFile(sourceFilePath, targetFilePath) ? 'linked' : 'failed'
}

/**
 * Drops duplicate and self-referential sources so one launch links each home once.
 */
function dedupeSourceHomes(
  sourceCodexHomePaths: readonly string[],
  targetCodexHomePath: string
): string[] {
  const seen = new Set([normalizeRuntimePathForComparison(targetCodexHomePath)])
  const sources: string[] = []
  for (const sourceHomePath of sourceCodexHomePaths) {
    const key = normalizeRuntimePathForComparison(sourceHomePath)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    sources.push(sourceHomePath)
  }
  return sources
}

export const _internals = {
  resetBackgroundBridgeTasks: (): void => {
    backgroundBridgeTasksByTargetHome.clear()
    bridgedDirectoriesByTargetHome.clear()
  }
}
