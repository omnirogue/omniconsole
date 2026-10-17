/**
 * Binds a CLI call to an automatic cleanup run by its process tree, not its environment: a
 * cleanup session that strips or forges its pane evidence (`env -u ORCA_PANE_KEY omni …`) still
 * runs under the run's PTY, and the CLI sends no pane evidence at all for terminal methods. A
 * caller whose ancestry reaches the PTY root of the live run, or of a recently finished one whose
 * terminal is still open, is unattended. While a run is live, a caller whose ancestry cannot be
 * read is unattended too, unless it proves a pane of its own. Loss of evidence never widens authority.
 */

import type { SessionManageUnattended } from '../../shared/session-manage-types'

export type ProcessParentRow = { pid: number; ppid: number }

/** What the caller's pane evidence proved, when it proved anything. */
export type VerifiedCallerPane = { paneKey: string; worktreeId: string | null }

export type LiveAutomaticCleanupRun = {
  context: SessionManageUnattended
  /** Known once the run is dispatched. */
  ptyId: string | null
  paneKey: string | null
  /** The fixed cleanup workspace every run's pane opens in. */
  workspaceId: string | null
  /** Panes of the person's own (Clean up now) runs in that workspace. */
  manualPaneKeys: ReadonlySet<string>
}

/** A finished automatic run whose terminal may still be open (End has not closed it yet). */
export type LingeringAutomaticCleanupRun = { context: SessionManageUnattended; ptyId: string }

export type CleanupCallerBindingDeps = {
  liveAutomaticRun: () => LiveAutomaticCleanupRun | null
  lingeringAutomaticRuns: () => readonly LingeringAutomaticCleanupRun[]
  /** Root pids of those PTYs that still exist, from one listing. */
  ptyRootPids: (ptyIds: readonly string[]) => Promise<ReadonlyMap<string, number>>
  readProcessRows: () => Promise<readonly ProcessParentRow[]>
  verifyPane: () => VerifiedCallerPane | null
}

const MAX_ANCESTRY_DEPTH = 128

/** True when `pid` is `rootPid` or one of its descendants in this table. */
export function descendsFrom(
  rows: readonly ProcessParentRow[],
  pid: number,
  rootPid: number
): boolean {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  let current: number | undefined = pid
  for (let depth = 0; current !== undefined && depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (current === rootPid) {
      return true
    }
    const parent = parentOf.get(current)
    // Why stop at 0/1 and self-loops: init reparenting ends every chain there.
    current = parent === undefined || parent <= 1 || parent === current ? undefined : parent
  }
  return false
}

type CallerTree = {
  /** The run whose PTY tree the caller is in. */
  inside: SessionManageUnattended | null
  /** The table named the caller and every one of these PTYs' roots. */
  determinedFor: ReadonlySet<string>
}

const UNKNOWN: CallerTree = { inside: null, determinedFor: new Set() }

async function readCallerTree(
  deps: CleanupCallerBindingDeps,
  candidates: readonly LingeringAutomaticCleanupRun[],
  callerPid: number | undefined
): Promise<CallerTree> {
  if (!callerPid || candidates.length === 0) {
    return UNKNOWN
  }
  try {
    const roots = await deps.ptyRootPids(candidates.map((candidate) => candidate.ptyId))
    // Why: a terminal already closed cannot hold the caller, so no process table is read for it.
    if (roots.size === 0) {
      return UNKNOWN
    }
    const rows = await deps.readProcessRows()
    if (!rows.some((row) => row.pid === callerPid)) {
      return UNKNOWN
    }
    const inside = candidates.find((candidate) => {
      const root = roots.get(candidate.ptyId)
      return root !== undefined && descendsFrom(rows, callerPid, root)
    })
    return { inside: inside?.context ?? null, determinedFor: new Set(roots.keys()) }
  } catch {
    return UNKNOWN
  }
}

export async function bindCallerToCleanupRun(
  deps: CleanupCallerBindingDeps,
  callerPid: number | undefined
): Promise<SessionManageUnattended | null> {
  const run = deps.liveAutomaticRun()
  const candidates = [
    ...(run?.ptyId ? [{ context: run.context, ptyId: run.ptyId }] : []),
    ...deps.lingeringAutomaticRuns()
  ]
  if (!run && candidates.length === 0) {
    return null
  }
  const tree = await readCallerTree(deps, candidates, callerPid)
  if (tree.inside || !run) {
    return tree.inside
  }
  if (run.ptyId && tree.determinedFor.has(run.ptyId)) {
    return null
  }
  const pane = deps.verifyPane()
  if (!pane) {
    return run.context
  }
  // Why: before the run reports its pane, a proven pane in the cleanup workspace is that run's.
  const unreportedRunPane =
    !run.paneKey &&
    run.workspaceId !== null &&
    pane.worktreeId === run.workspaceId &&
    !run.manualPaneKeys.has(pane.paneKey)
  return unreportedRunPane || pane.paneKey === run.paneKey ? run.context : null
}
