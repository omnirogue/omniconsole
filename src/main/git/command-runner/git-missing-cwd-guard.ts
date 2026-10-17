import { isAbsolute } from 'node:path'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  hasMissingGitCwdVerdict,
  isKnownMissingGitCwd,
  missingGitCwdError,
  recordGitSpawnFailureCwd
} from '../non-repo-folder-verdicts'

/** Host-native cwd the missing-folder guard may stat; WSL-routed and relative cwds are left alone. */
function missingCwdGuardPath(options: { cwd?: string; wslDistro?: string }): string | null {
  const cwd = options.cwd
  return cwd && !options.wslDistro && isAbsolute(cwd) && !parseWslUncPath(cwd) ? cwd : null
}

// Why: pollers kept spawning git in deleted folders every few seconds (#857); a gone cwd never spawns again.
export function withMissingCwdGuard<T>(
  args: string[],
  options: { cwd?: string; wslDistro?: string },
  run: () => Promise<T>
): Promise<T> {
  const cwd = missingCwdGuardPath(options)
  if (!cwd) {
    return run()
  }
  const guarded = (): Promise<T> =>
    run().catch(async (error: unknown) => {
      await recordGitSpawnFailureCwd(cwd, error)
      throw error
    })
  // Why sync fast path: a cwd with no verdict must spawn exactly as before, with no added await.
  if (!hasMissingGitCwdVerdict(cwd)) {
    return guarded()
  }
  return isKnownMissingGitCwd(cwd).then((missing) => {
    if (missing) {
      throw missingGitCwdError(args)
    }
    return guarded()
  })
}
