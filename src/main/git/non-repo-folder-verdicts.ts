import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { getErrorCode, isNotGitRepositoryError } from './worktree-operation-options'

/**
 * Remembers folders where Git already failed for a reason re-running cannot fix, so background
 * pollers stop spawning `git` there (#857: thousands of failing spawns a day on folder workspaces).
 *
 * - `not-a-repo`: re-checked once a `.git` appears in the folder (local filesystems) or it gains focus.
 * - `missing`: the folder no longer exists; re-checked when it reappears or gains focus.
 */
export type NonRepoFolderVerdict = 'not-a-repo' | 'missing'

type VerdictEntry = { verdict: NonRepoFolderVerdict; hostId: string; folderPath: string }

const MAX_VERDICTS = 512
const verdicts = new Map<string, VerdictEntry>()
let lastFocusedFolderPath: string | null = null

function verdictKey(hostId: string, folderPath: string): string {
  return `${hostId}\0${folderPath}`
}

/** SSH hosts run Git off-box, so a local stat cannot describe their folders. */
// Why its own scope: the runner guard already blocks the spawn, so its verdicts must not also
// short-circuit callers (e.g. the worktree scan) that record and consult their own.
const GIT_RUNNER_CWD_SCOPE = 'local:git-runner-cwd'

function isLocalFilesystemHost(hostId: string): boolean {
  return (
    hostId === LOCAL_EXECUTION_HOST_ID ||
    hostId === GIT_RUNNER_CWD_SCOPE ||
    hostId.startsWith('wsl:')
  )
}

async function pathExists(path: string): Promise<boolean | undefined> {
  try {
    await stat(path)
    return true
  } catch (error) {
    // Why: only ENOENT proves absence; EACCES or a hung mount must not drop a live folder.
    return getErrorCode(error) === 'ENOENT' ? false : undefined
  }
}

function isEnoentError(error: unknown): boolean {
  // Why the message fallback: wrapped runner errors can drop `code` but keep "spawn git ENOENT".
  return (
    getErrorCode(error) === 'ENOENT' ||
    (error instanceof Error && /\bspawn \S+ ENOENT\b/.test(error.message))
  )
}

/** True when Git should not be spawned in this folder; a new `.git` or a reappearing folder lifts the verdict. */
export async function shouldSkipGitInFolder(hostId: string, folderPath: string): Promise<boolean> {
  const key = verdictKey(hostId, folderPath)
  const entry = verdicts.get(key)
  if (!entry) {
    return false
  }
  if (isLocalFilesystemHost(hostId)) {
    const lifted =
      entry.verdict === 'not-a-repo'
        ? (await pathExists(join(folderPath, '.git'))) === true
        : (await pathExists(folderPath)) !== false
    if (lifted) {
      if (verdicts.get(key) === entry) {
        verdicts.delete(key)
      }
      return false
    }
  }
  return verdicts.get(key) === entry
}

function rememberVerdict(hostId: string, folderPath: string, verdict: NonRepoFolderVerdict): void {
  const key = verdictKey(hostId, folderPath)
  verdicts.delete(key)
  verdicts.set(key, { verdict, hostId, folderPath })
  while (verdicts.size > MAX_VERDICTS) {
    const oldest = verdicts.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    verdicts.delete(oldest)
  }
}

async function isConfirmedMissingCwd(
  hostId: string,
  folderPath: string,
  error: unknown
): Promise<boolean> {
  return (
    isEnoentError(error) &&
    isLocalFilesystemHost(hostId) &&
    // Why: "spawn git ENOENT" also means git itself is missing; only a vanished cwd is permanent.
    (await pathExists(folderPath)) === false
  )
}

/**
 * Classify a Git failure for this folder. Returns the verdict it recorded, or null when the
 * failure may be transient (timeouts, lock contention, a missing git binary) and must be retried.
 */
export async function recordGitFailureInFolder(
  hostId: string,
  folderPath: string,
  error: unknown
): Promise<NonRepoFolderVerdict | null> {
  const verdict: NonRepoFolderVerdict | null = isNotGitRepositoryError(error)
    ? 'not-a-repo'
    : (await isConfirmedMissingCwd(hostId, folderPath, error))
      ? 'missing'
      : null
  if (verdict) {
    rememberVerdict(hostId, folderPath, verdict)
  }
  return verdict
}

/**
 * Local git runner guard: a cwd already proven gone costs one stat per call instead of a spawn.
 * Only `missing` applies here — many commands (clone, config, ls-remote) legitimately run outside a repo.
 */
export async function isKnownMissingGitCwd(folderPath: string): Promise<boolean> {
  return hasMissingGitCwdVerdict(folderPath)
    ? shouldSkipGitInFolder(GIT_RUNNER_CWD_SCOPE, folderPath)
    : false
}

export function hasMissingGitCwdVerdict(folderPath: string): boolean {
  return verdicts.get(verdictKey(GIT_RUNNER_CWD_SCOPE, folderPath))?.verdict === 'missing'
}

/** Records a `missing` verdict when a local spawn failed because its cwd no longer exists. */
export async function recordGitSpawnFailureCwd(folderPath: string, error: unknown): Promise<void> {
  if (await isConfirmedMissingCwd(GIT_RUNNER_CWD_SCOPE, folderPath, error)) {
    rememberVerdict(GIT_RUNNER_CWD_SCOPE, folderPath, 'missing')
  }
}

/** The error Node raises for a spawn whose cwd is gone, so callers keep their existing handling. */
export function missingGitCwdError(args: readonly string[]): Error {
  return Object.assign(new Error('spawn git ENOENT'), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'spawn git',
    path: 'git',
    spawnargs: [...args]
  })
}

/** A workspace gaining focus earns its folder one fresh Git check on every host. */
export function noteFolderFocused(folderPath: string | null | undefined): void {
  if (!folderPath || folderPath === lastFocusedFolderPath) {
    return
  }
  lastFocusedFolderPath = folderPath
  for (const [key, entry] of verdicts) {
    if (entry.folderPath === folderPath) {
      verdicts.delete(key)
    }
  }
}

export function _resetNonRepoFolderVerdictsForTests(): void {
  verdicts.clear()
  lastFocusedFolderPath = null
}
