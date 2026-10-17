import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import {
  encodeGitCheckIgnorePaths,
  GIT_CHECK_IGNORE_STDIN_ARGS,
  GIT_CHECK_IGNORE_TIMEOUT_MS,
  parseGitCheckIgnorePaths,
  splitGitCheckIgnorePathsByStdinBytes
} from '../../shared/git-check-ignore-stdio'

type GitExecError = Error & { stdout?: string; code?: number | string }
type CheckIgnoredPathsOptions = GitRuntimeOptions & { noIndex?: boolean }

async function runCheckIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: CheckIgnoredPathsOptions
): Promise<string[]> {
  const args: string[] = [...GIT_CHECK_IGNORE_STDIN_ARGS]
  if (options.noIndex) {
    args.splice(3, 0, '--no-index')
  }
  try {
    const { stdout } = await gitExecFileAsync(args, {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: encodeGitCheckIgnorePaths(relativePaths),
      timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
    })
    return parseGitCheckIgnorePaths(stdout)
  } catch (error) {
    const gitError = error as GitExecError
    if (gitError.code === 1) {
      return parseGitCheckIgnorePaths(gitError.stdout ?? '')
    }
    throw error
  }
}

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: CheckIgnoredPathsOptions = {}
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return []
  }
  const ignored = new Set<string>()
  for (const chunk of splitGitCheckIgnorePathsByStdinBytes(relativePaths)) {
    for (const ignoredPath of await runCheckIgnoredPaths(worktreePath, chunk, options)) {
      ignored.add(ignoredPath)
    }
  }
  return Array.from(ignored)
}
