import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleLocalJob } from './console-local-execution-contract'
import type { ConsoleJobWorktree } from './console-job-worktree'

export async function resolveConsoleFolderJobWorkspace(
  runtime: OrcaRuntimeService,
  selector: string,
  job: ConsoleLocalJob
): Promise<ConsoleJobWorktree> {
  if (!job.workspace || job.workspace.kind !== 'folder' || !isAbsolute(job.workspace.path)) {
    throw new Error('The admitted folder job requires an absolute workspace path.')
  }
  const workspace = await runtime.showManagedTerminalWorkspace(selector)
  if (workspace.hostId && workspace.hostId !== 'local') {
    throw new Error('The selected folder executes on another host; its state is unverifiable here.')
  }
  if (parseWorkspaceKey(workspace.id)?.type !== 'folder') {
    throw new Error('Select the existing folder workspace frozen in the admitted job.')
  }
  const path = workspace.git.path
  if (process.platform === 'win32' && parseWslUncPath(path)) {
    throw new Error('Local WSL folder execution requires an execution-host process adapter.')
  }
  const [expected, actual, directory] = await Promise.all([
    realpath(job.workspace.path),
    realpath(path),
    stat(path)
  ])
  if (actual !== expected || !directory.isDirectory()) {
    throw new Error('The selected folder does not match the workspace frozen in the admitted job.')
  }
  return { id: workspace.id, path: actual, branch: null, startSha: null }
}
