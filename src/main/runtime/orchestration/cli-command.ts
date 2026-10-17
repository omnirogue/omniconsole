import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from '../../cli/cli-install-constants'

export type OrchestrationCliCommand = 'omni' | 'omni-ide'

/**
 * What a worker preamble names as the CLI: a bare command for hosts that register
 * one (SSH, WSL, the Linux shim) or an absolute launcher path for a local terminal.
 */
export type OrchestrationCliReference = OrchestrationCliCommand | (string & {})

/**
 * The absolute launcher a local terminal can always run, or null when none is on disk.
 * Why: a bare `omni` resolves through the worker's login shell, whose rc files reorder
 * PATH. On a Mac that also carries another `omni` (a Python CLI behind a pyenv shim)
 * every heartbeat and worker_done reached the wrong program, and the run only finished
 * because most workers hunted for this path themselves.
 */
export function resolveLocalOrchestrationCliLauncher(args: {
  isPackaged: boolean
  userDataPath: string
  resourcesPath: string | undefined
  platform: NodeJS.Platform
  exists?: (path: string) => boolean
}): string | null {
  const exists = args.exists ?? existsSync
  let candidate: string | null = null
  if (!args.isPackaged) {
    candidate = join(args.userDataPath, ...DEV_LAUNCHER_DIR, DEV_COMMAND_NAME)
  } else if (args.platform === 'darwin' && args.resourcesPath) {
    // Why: the packaged app bundles its CLI under Resources/bin; the global
    // /usr/local/bin registration is optional and can be shadowed either way.
    candidate = join(args.resourcesPath, 'bin', 'omni')
  }
  return candidate && exists(candidate) ? candidate : null
}

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** Absolute launcher for local terminals; SSH and WSL hosts keep their bare names. */
  localLauncher?: string | null
}): OrchestrationCliReference {
  if (args.connectionId) {
    return 'omni'
  }
  const local: OrchestrationCliReference = args.localLauncher ?? 'omni'
  if (args.isWsl !== null && args.isWsl !== undefined) {
    return args.isWsl ? 'omni-ide' : local
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'omni-ide'
  }

  const worktreePath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath
  return worktreePath && isWslUncPath(worktreePath) ? 'omni-ide' : local
}
