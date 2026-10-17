import { join } from 'node:path'
import { SESSION_CHAIN_OUTPUT_ROOT } from '../../../shared/session-chain-types'
import { isLocalRunEditingPreset } from '../../../shared/local-run-node-state'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import type { WorkerPlacement } from './build-review-worker-lifecycle'

export type LocalRunWorkspaceKind = 'folder' | 'git'

/** The folder one node writes into: `<workspace>/.omni/runs/<runId>/<taskId>/`. */
export function localRunNodeOutputDir(
  workspacePath: string,
  runId: string,
  taskId: string
): string {
  return join(workspacePath, ...SESSION_CHAIN_OUTPUT_ROOT.split('/'), runId, taskId)
}

/** The report one node is told to write: `<workspace>/.omni/runs/<runId>/<taskId>.md`. */
export function localRunNodeReportPath(
  workspacePath: string,
  runId: string,
  taskId: string
): string {
  return join(workspacePath, ...SESSION_CHAIN_OUTPUT_ROOT.split('/'), runId, `${taskId}.md`)
}

export type LocalRunPlacementInput = {
  workspaceKind: LocalRunWorkspaceKind
  workspacePath: string
  runId: string
  taskId: string
  nodeId: string
  presetId: SessionActionPresetId
  /** True when a sibling node can be dispatched at the same time as this one. */
  parallel: boolean
}

/**
 * Isolation by workspace kind.
 *
 * A folder workspace cannot create a worktree (orchestration refuses it), so two
 * parallel nodes are separated by giving each its own subfolder as the worker's
 * initial working directory. A git workspace can do better for nodes that EDIT: a
 * child worktree keeps their diffs apart. Sequential nodes, and read-only nodes that
 * only look and report, stay in the workspace root where the material actually is.
 */
export function resolveLocalRunPlacement(input: LocalRunPlacementInput): WorkerPlacement {
  if (!input.parallel) {
    return { worktree: 'current' }
  }
  if (input.workspaceKind === 'git') {
    return isLocalRunEditingPreset(input.presetId)
      ? { worktree: 'new-child', name: localRunChildWorktreeName(input.runId, input.nodeId) }
      : { worktree: 'current' }
  }
  return {
    worktree: 'current',
    cwd: localRunNodeOutputDir(input.workspacePath, input.runId, input.taskId)
  }
}

/** A branch/worktree name that is unique per Run and readable in the sidebar. */
export function localRunChildWorktreeName(runId: string, nodeId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)
  return `${safe(runId)}-${safe(nodeId)}`
}
