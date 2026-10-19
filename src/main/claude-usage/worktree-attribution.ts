import { realpath } from 'node:fs/promises'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import type { ClaudeUsageAttributedTurn, ClaudeUsageParsedTurn } from './types'

export type ClaudeUsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

type ClaudeUsageWorktreeEntry = [string, ClaudeUsageWorktreeRef]

const sortedWorktreeEntriesByLookup = new WeakMap<
  Map<string, ClaudeUsageWorktreeRef>,
  ClaudeUsageWorktreeEntry[]
>()

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

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await realpath(pathValue)
    return normalizeComparablePath(resolved)
  } catch {
    return normalizeComparablePath(pathValue)
  }
}

function normalizeComparablePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isContainedPath(parentPath: string, childPath: string): boolean {
  const parent = normalizeComparablePath(parentPath).replace(/\/+$/, '')
  const child = normalizeComparablePath(childPath).replace(/\/+$/, '')
  return child === parent || child.startsWith(`${parent}/`)
}

function findContainingWorktree(
  cwd: string,
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): ClaudeUsageWorktreeRef | null {
  const normalizedCwd = normalizeComparablePath(cwd)
  const exact = worktreeLookup.get(normalizedCwd)
  if (exact) {
    return exact
  }

  for (const [worktreePath, worktree] of getSortedWorktreeEntries(worktreeLookup)) {
    if (isContainedPath(worktreePath, normalizedCwd)) {
      return worktree
    }
  }

  return null
}

function getSortedWorktreeEntries(
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): ClaudeUsageWorktreeEntry[] {
  const cached = sortedWorktreeEntriesByLookup.get(worktreeLookup)
  if (cached) {
    return cached
  }
  const sorted = [...worktreeLookup.entries()].sort(
    ([leftPath], [rightPath]) => rightPath.length - leftPath.length
  )
  sortedWorktreeEntriesByLookup.set(worktreeLookup, sorted)
  return sorted
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

export async function buildWorktreeLookup(
  worktrees: ClaudeUsageWorktreeRef[]
): Promise<Map<string, ClaudeUsageWorktreeRef>> {
  const canonicalized = await canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
  const lookup = new Map<string, ClaudeUsageWorktreeRef>()
  for (const worktree of canonicalized) {
    lookup.set(worktree.canonicalPath, {
      repoId: worktree.repoId,
      worktreeId: worktree.worktreeId,
      path: worktree.path,
      displayName: worktree.displayName
    })
  }
  return lookup
}

export function getClaudeUsageCwdAttribution(worktree: ClaudeUsageWorktreeRef | null): string | null {
  return worktree
    ? JSON.stringify([worktree.repoId, worktree.worktreeId, worktree.displayName])
    : null
}

export async function resolveClaudeUsageCwdWorktree(
  cwd: string,
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>,
  canonicalCwdByPath?: Map<string, string>
): Promise<ClaudeUsageWorktreeRef | null> {
  let canonicalCwd = canonicalCwdByPath?.get(cwd)
  if (canonicalCwd === undefined) {
    canonicalCwd = await canonicalizePath(cwd)
    canonicalCwdByPath?.set(cwd, canonicalCwd)
  }
  return findContainingWorktree(canonicalCwd, worktreeLookup)
}

export async function attributeClaudeUsageTurns(
  turns: ClaudeUsageParsedTurn[],
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>,
  canonicalCwdByPath = new Map<string, string>(),
  attributionByCwd?: Record<string, string | null>
): Promise<ClaudeUsageAttributedTurn[]> {
  const attributed: ClaudeUsageAttributedTurn[] = []

  for (const turn of turns) {
    const day = localDayFromTimestamp(turn.timestamp)
    if (!day) {
      continue
    }

    let repoId: string | null = null
    let worktreeId: string | null = null
    let projectKey = 'unscoped'
    let projectLabel = getDefaultProjectLabel(turn.cwd)

    if (turn.cwd) {
      // Why: Claude transcripts repeat the same cwd for many consecutive
      // turns. Cache realpath work so attribution scales with unique paths.
      const worktree = await resolveClaudeUsageCwdWorktree(
        turn.cwd,
        worktreeLookup,
        canonicalCwdByPath
      )
      if (attributionByCwd && !Object.hasOwn(attributionByCwd, turn.cwd)) {
        attributionByCwd[turn.cwd] = getClaudeUsageCwdAttribution(worktree)
      }
      if (worktree) {
        repoId = worktree.repoId
        worktreeId = worktree.worktreeId
        projectKey = `worktree:${worktreeId}`
        projectLabel = worktree.displayName
      } else {
        projectKey = `cwd:${normalizeComparablePath(turn.cwd)}`
      }
    }

    attributed.push({
      ...turn,
      day,
      projectKey,
      projectLabel,
      repoId,
      worktreeId
    })
  }

  return attributed
}
