import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git/git-runtime-options'
import { gitExecFileAsync, promptGuardGitEnv } from '../git/runner'

/** The git calls the handoff routes share: one runner, one optional-read, one ancestry check. */
export class HandoffGitRouteError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_a_repository'
      | 'commit_failed'
      | 'push_failed'
      | 'push_unverifiable'
      | 'source_changed'
      | 'filter_mismatch'
      | 'fetch_failed'
      | 'checkout_failed',
    message: string
  ) {
    super(message)
    this.name = 'HandoffGitRouteError'
  }
}

/** git puts the useful part of a failure on stderr, sometimes on stdout, sometimes neither. */
export function gitErrorText(error: unknown): string {
  const record = error as { stderr?: unknown; stdout?: unknown } | null
  for (const field of ['stderr', 'stdout'] as const) {
    const value = record?.[field]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return error instanceof Error ? error.message : String(error)
}

export async function handoffGit(
  args: string[],
  worktreePath: string,
  options: GitRuntimeOptions,
  indexFile?: string
): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, {
    ...gitOptionsForWorktree(worktreePath, options),
    // Why: `env` replaces the child's environment wholesale, so the prompt guard is composed here
    // rather than assumed; a handoff must never stall on a credential prompt nobody can answer.
    env: indexFile ? { ...promptGuardGitEnv(), GIT_INDEX_FILE: indexFile } : promptGuardGitEnv()
  })
  return stdout.trim()
}

/** The command's output, or null when it printed nothing or failed. Never use for exit-code tests. */
export async function handoffGitRead(
  args: string[],
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const value = await handoffGit(args, worktreePath, options)
    return value || null
  } catch {
    return null
  }
}

/**
 * True when `candidate` is already contained in `tip`.
 *
 * `merge-base --is-ancestor` answers with its exit code and prints nothing, so its success and its
 * failure both read as an empty string; only the throw distinguishes them.
 */
export async function handoffGitIsAncestor(
  candidate: string,
  tip: string,
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  if (candidate === tip) {
    return true
  }
  try {
    await handoffGit(['merge-base', '--is-ancestor', candidate, tip], worktreePath, options)
    return true
  } catch {
    return false
  }
}

/** The repository root that owns `worktreePath`. */
export async function handoffRepoRoot(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    return await handoffGit(['rev-parse', '--show-toplevel'], worktreePath, options)
  } catch (error) {
    throw new HandoffGitRouteError('not_a_repository', gitErrorText(error))
  }
}
