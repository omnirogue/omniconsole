import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { resolveWorkspaceOutputPath } from '../../../../shared/session-follow-up-deliverables'

/** The session whose workspace is read: its worktree, the host that executes it, the path. */
export type SessionChangeTarget = {
  worktreeId: string
  hostId?: ExecutionHostId | null
  workspacePath: string | null
}

/** What a person handoff sends when nobody chose files: the files this workspace changed. */
export type SessionChangedFiles = {
  paths: string[]
  /** More files changed than a handoff carries; the first ones are listed. */
  truncated: boolean
}

/** Deleted files cannot travel; everything else the workspace changed is a candidate. */
const CHANGED_STATUSES = new Set(['modified', 'added', 'untracked', 'renamed', 'copied'])

/** Absolute workspace paths for the changed entries, in git order, deduplicated and capped. */
export function sessionChangedFilesFromStatus(
  entries: readonly GitStatusEntry[],
  workspacePath: string,
  limit: number
): SessionChangedFiles {
  const paths: string[] = []
  for (const entry of entries) {
    if (!CHANGED_STATUSES.has(entry.status) || entry.submodule) {
      continue
    }
    const absolute = resolveWorkspaceOutputPath(workspacePath, entry.path)
    if (absolute && !paths.includes(absolute)) {
      paths.push(absolute)
    }
  }
  return { paths: paths.slice(0, limit), truncated: paths.length > limit }
}

/**
 * Detected files come first; anything the person added on top of an earlier detection stays.
 * Files the person removed from the earlier detection are not brought back.
 */
export function mergeSessionFiles(args: {
  detected: string[]
  current: string[]
  previousDetected: string[]
  limit: number
}): string[] {
  const extras = args.current.filter((path) => !args.previousDetected.includes(path))
  const removed = args.previousDetected.filter((path) => !args.current.includes(path))
  const merged = [...args.detected.filter((path) => !removed.includes(path)), ...extras]
  return [...new Set(merged)].slice(0, args.limit)
}

/**
 * Read the workspace's git status through the same client the source-control views use, on
 * whichever host executes the session. Null when the workspace is not a repository or the
 * status cannot be read; the package then starts empty and the person adds files.
 */
export async function detectSessionChangedFiles(
  target: SessionChangeTarget,
  limit: number,
  signal?: AbortSignal
): Promise<SessionChangedFiles | null> {
  const { worktreeId, workspacePath } = target
  if (!workspacePath) {
    return null
  }
  const state = useAppStore.getState()
  const hostId = target.hostId ?? null
  const parsedHost = parseExecutionHostId(hostId)
  const worktree = state.getKnownWorktreeById(worktreeId, hostId ?? undefined)
  const owner =
    hostId && worktree?.repoId
      ? findRepoForHost(state.repos, worktree.repoId, { hostId })
      : undefined
  const settings = hostId
    ? {
        ...state.settings,
        activeRuntimeEnvironmentId: parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
      }
    : getSettingsForWorktreeRuntimeOwner(
        { repos: state.repos, settings: state.settings, worktreesByRepo: state.worktreesByRepo },
        worktreeId
      )
  try {
    const status = await getRuntimeGitStatus(
      {
        settings,
        worktreeId,
        worktreePath: workspacePath,
        connectionId: hostId
          ? (owner?.connectionId ?? undefined)
          : (getConnectionId(worktreeId) ?? undefined)
      },
      { admissionTier: 'interactive', includeLineStats: false, ...(signal ? { signal } : {}) }
    )
    return sessionChangedFilesFromStatus(status.entries, workspacePath, limit)
  } catch {
    return null
  }
}

export type SessionChangedFilesState = {
  detected: SessionChangedFiles | null
  loading: boolean
  /** Read the status again, for files the session produced since the last look. */
  refresh: () => void
}

/** Detect once when enabled, and again on demand; a stale answer never lands after a newer one. */
export function useSessionChangedFiles(
  target: SessionChangeTarget | null,
  limit: number,
  enabled: boolean
): SessionChangedFilesState {
  const [detected, setDetected] = useState<SessionChangedFiles | null>(null)
  const [loading, setLoading] = useState(false)
  const [generation, setGeneration] = useState(0)
  const latest = useRef(0)
  const worktreeId = target?.worktreeId ?? null
  const hostId = target?.hostId ?? null
  const workspacePath = target?.workspacePath ?? null
  useEffect(() => {
    if (!enabled || !worktreeId || !workspacePath) {
      return
    }
    const controller = new AbortController()
    const run = ++latest.current
    setLoading(true)
    void detectSessionChangedFiles(
      { worktreeId, hostId, workspacePath },
      limit,
      controller.signal
    ).then((result) => {
      if (controller.signal.aborted || latest.current !== run) {
        return
      }
      setDetected(result)
      setLoading(false)
    })
    return () => controller.abort()
  }, [enabled, worktreeId, hostId, workspacePath, limit, generation])
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  return { detected, loading, refresh }
}
