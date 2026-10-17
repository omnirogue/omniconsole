import { win32, posix } from 'node:path'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import {
  looksLikeWindowsPath,
  normalizeComparablePath,
  normalizeFsPath
} from '../usage/usage-path-comparison'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { CodexUsageAttributedEvent, CodexUsageParsedEvent } from './types'

export type CodexUsageWorktreeRef = UsageScanWorktreeRef

function getDefaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts.at(-1) ?? cwd
}

function localDayFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isContainingPath(candidatePath: string, targetPath: string): boolean {
  const useWin32 = looksLikeWindowsPath(candidatePath) || looksLikeWindowsPath(targetPath)
  const relativePath = useWin32
    ? win32.relative(candidatePath, targetPath)
    : posix.relative(candidatePath, targetPath)
  if (!relativePath) {
    return true
  }
  // Why: on Windows, `path.relative('C:\\repo', 'D:\\other')` returns an
  // absolute `D:\\other` path instead of a `..`-prefixed relative. Treating
  // that as "contained" would attribute off-drive Codex usage to the wrong
  // OmniConsole worktree.
  const isAbsoluteRelative = useWin32
    ? win32.isAbsolute(relativePath)
    : posix.isAbsolute(relativePath)
  const parentPrefix = useWin32 ? `..${win32.sep}` : `..${posix.sep}`
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

function findContainingWorktree(
  cwd: string,
  worktrees: (CodexUsageWorktreeRef & { canonicalPath: string })[]
): CodexUsageWorktreeRef | null {
  const normalizedCwd = normalizeFsPath(cwd)
  for (const worktree of worktrees) {
    if (areWorktreePathsEqual(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
    if (isContainingPath(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
  }
  return null
}

export type CodexUsageWorktreeResolver = (cwd: string) => CodexUsageWorktreeRef | null

/**
 * Resolves a cwd to its containing worktree once per scan. Why: every token_count event carries a
 * cwd, and matching it against every known worktree with path normalization per event was ~70% of
 * main-process CPU during a full rescan (mac-studio, 2026-09-28: ~11k rollouts x ~150 worktrees).
 */
export function createCodexUsageWorktreeResolver(
  worktrees: (CodexUsageWorktreeRef & { canonicalPath: string })[]
): CodexUsageWorktreeResolver {
  const byCwd = new Map<string, CodexUsageWorktreeRef | null>()
  return (cwd) => {
    let worktree = byCwd.get(cwd)
    if (worktree === undefined) {
      worktree = findContainingWorktree(cwd, worktrees)
      byCwd.set(cwd, worktree)
    }
    return worktree
  }
}

/** What a cwd was attributed to; a cached file is reusable while all of its cwds still match. */
export function getCodexUsageCwdAttribution(worktree: CodexUsageWorktreeRef | null): string | null {
  return worktree
    ? JSON.stringify([worktree.repoId, worktree.worktreeId, worktree.displayName])
    : null
}

export async function attributeCodexUsageEvent(
  event: CodexUsageParsedEvent,
  worktrees: (CodexUsageWorktreeRef & { canonicalPath: string })[] | CodexUsageWorktreeResolver
): Promise<CodexUsageAttributedEvent | null> {
  const day = localDayFromTimestamp(event.timestamp)
  if (!day) {
    return null
  }

  let repoId: string | null = null
  let worktreeId: string | null = null
  let projectKey = 'unscoped'
  let projectLabel = getDefaultProjectLabel(event.cwd)

  if (event.cwd) {
    const worktree =
      typeof worktrees === 'function'
        ? worktrees(event.cwd)
        : findContainingWorktree(event.cwd, worktrees)
    if (worktree) {
      repoId = worktree.repoId
      worktreeId = worktree.worktreeId
      projectKey = `worktree:${worktree.worktreeId}`
      projectLabel = worktree.displayName
    } else {
      // Why: all-local mode should still collapse repeated off-OmniConsole sessions by
      // location, but those keys must normalize slash/case differences so the
      // same folder does not fragment into multiple "projects" across platforms.
      projectKey = `cwd:${normalizeComparablePath(event.cwd)}`
    }
  }

  return {
    ...event,
    day,
    projectKey,
    projectLabel,
    repoId,
    worktreeId
  }
}
