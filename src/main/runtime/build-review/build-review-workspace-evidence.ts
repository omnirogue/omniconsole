import type { OrchestrationDb } from '../orchestration/db/orchestration-db'

export type BuildReviewReservation = {
  workspace_key: string
  pipeline_id: string
  runtime_epoch: string
  owner_pid: number
  run_id: string | null
  worker_start_in_flight: number
  worker_dispatch_ids: string
}

/**
 * Why one Dispatch of a reserved Run still counts. `worker-active`: the worker never settled, so it
 * may still be editing. `terminal-open`: the worker settled but a terminal it started (or the
 * authority it holds) is not released yet. `unreadable`: its evidence cannot be parsed.
 */
export type UnresolvedBuildReviewDispatch = {
  id: string
  kind: 'worker-active' | 'terminal-open' | 'unreadable'
  /** The agent terminal: its owned resource, else the one the worker recorded. */
  terminalHandle: string | null
  processIncarnation: string | null
  hostScope: string | null
  /** True once the owned terminal resource itself was released. */
  terminalReleased: boolean
  /**
   * A start that failed after its prompt may have landed keeps its authority (#16095): the agent
   * in that terminal may be working on the task, so only its own exit, or the person closing it,
   * counts it out. Release never closes it.
   */
  mayBeWorking: boolean
  /**
   * Release workspace can close this terminal: the run still owns it and nothing may be working
   * in it. A terminal it only left behind (a failed start's, one it reused) waits for its exit.
   */
  releasable: boolean
}

type DispatchRow = {
  id: string
  task_id: string
  /** Insertion order: a later start of the same Task has a higher one. */
  seq: number
  status: string
  capability_revoked_at: string | null
  state: string | null
  residual_resources: string | null
  agent_terminal_handle: string | null
  terminal_handle: string | null
  ownership_state: string | null
  release_state: string | null
  process_incarnation: string | null
  host_scope: string | null
}

export function readBuildReviewReservation(
  db: OrchestrationDb,
  workspaceKey: string
): BuildReviewReservation | undefined {
  return db.db
    .prepare('SELECT * FROM build_review_workspace_reservations WHERE workspace_key = ?')
    .get(workspaceKey) as BuildReviewReservation | undefined
}

function classify(row: DispatchRow): UnresolvedBuildReviewDispatch['kind'] | null {
  if (
    ['pending', 'dispatched'].includes(row.status) ||
    !row.state ||
    !['succeeded', 'failed', 'stopped'].includes(row.state)
  ) {
    return 'worker-active'
  }
  if (
    (row.state === 'failed' && !row.capability_revoked_at) ||
    (row.ownership_state === 'owned' && row.release_state !== 'released')
  ) {
    return 'terminal-open'
  }
  let residuals: unknown
  try {
    residuals = JSON.parse(row.residual_resources ?? '[]')
  } catch {
    return 'unreadable'
  }
  if (!Array.isArray(residuals)) {
    return 'unreadable'
  }
  const unreleased = residuals.filter(
    (resource) =>
      !resource ||
      resource.kind !== 'terminal' ||
      resource.role !== 'agent' ||
      resource.id !== row.terminal_handle ||
      row.release_state !== 'released'
  )
  if (unreleased.length === 0) {
    return null
  }
  // Why: only an agent terminal can be proven gone later; any other leftover (a created
  // worktree, an unknown shape) stays unresolved until someone looks at it.
  return unreleased.every((resource) => resource?.kind === 'terminal' && resource.role === 'agent')
    ? 'terminal-open'
    : 'unreadable'
}

function rowTerminal(row: DispatchRow): string | null {
  return row.terminal_handle ?? row.agent_terminal_handle
}

/**
 * A start that stopped on a question the person answered leaves its terminal to the start that
 * retried the same Task in it. Once that one succeeded the terminal is its to account for, and
 * its own record decides: one it only reused (the person's) does not hold the workspace.
 */
function supersededInItsTerminal(row: DispatchRow, rows: readonly DispatchRow[]): boolean {
  const handle = rowTerminal(row)
  return Boolean(
    handle &&
    rows.some(
      (later) =>
        later.id !== row.id &&
        later.task_id === row.task_id &&
        later.seq > row.seq &&
        later.state === 'succeeded' &&
        rowTerminal(later) === handle
    )
  )
}

/** Every Dispatch of the reserved Run that still keeps the workspace reserved, and why. */
export function unresolvedBuildReviewDispatches(
  db: OrchestrationDb,
  runId: string | null
): UnresolvedBuildReviewDispatch[] {
  if (!runId) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT d.id,d.task_id,d.rowid AS seq,d.status,d.capability_revoked_at,w.state,
              w.residual_resources,w.agent_terminal_handle,r.terminal_handle,r.ownership_state,
              r.release_state,r.process_incarnation,r.host_scope
       FROM dispatch_contexts d
       LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
       LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
       WHERE d.run_id = ? ORDER BY d.id`
    )
    .all(runId) as DispatchRow[]
  const unresolved = new Map<string, UnresolvedBuildReviewDispatch>()
  for (const row of rows) {
    const kind = classify(row)
    if (kind === 'terminal-open' && supersededInItsTerminal(row, rows)) {
      continue
    }
    if (kind && !unresolved.has(row.id)) {
      const mayBeWorking =
        kind === 'terminal-open' && row.state === 'failed' && !row.capability_revoked_at
      unresolved.set(row.id, {
        id: row.id,
        kind,
        terminalHandle: rowTerminal(row),
        processIncarnation: row.process_incarnation,
        hostScope: row.host_scope,
        terminalReleased: row.release_state === 'released',
        mayBeWorking,
        releasable:
          kind === 'terminal-open' &&
          !mayBeWorking &&
          row.ownership_state === 'owned' &&
          row.release_state !== 'released'
      })
    }
  }
  return [...unresolved.values()]
}

export function missingDispatchEvidence(
  db: OrchestrationDb,
  reservation: BuildReviewReservation
): boolean {
  let ids: unknown
  try {
    ids = JSON.parse(reservation.worker_dispatch_ids)
  } catch {
    return true
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return true
  }
  if (reservation.worker_start_in_flight !== 0) {
    return true
  }
  if (!reservation.run_id) {
    return ids.length > 0
  }
  if (!db.getRun(reservation.run_id)) {
    return true
  }
  const lookup = db.db.prepare('SELECT run_id FROM dispatch_contexts WHERE id = ?')
  return ids.some(
    (id) => (lookup.get(id) as { run_id: string } | undefined)?.run_id !== reservation.run_id
  )
}

/**
 * A reservation another run still holds. The message keeps the ids for logs and details; the
 * fields let the UI say it in plain words and offer the release.
 */
export class BuildReviewWorkspaceHeldError extends Error {
  constructor(
    readonly reservation: BuildReviewReservation,
    readonly unresolved: UnresolvedBuildReviewDispatch[],
    readonly missingEvidence: boolean,
    readonly ownerLive: boolean
  ) {
    super(
      `Build + Review pipeline ${reservation.pipeline_id} still owns this workspace${reservation.run_id ? ` (Run ${reservation.run_id})` : ''}${unresolved.length ? `; inspect unresolved Dispatch ${unresolved.map((entry) => entry.id).join(', ')}` : ''}${missingEvidence ? '; Run or Dispatch evidence is missing' : ''}.`
    )
    this.name = 'BuildReviewWorkspaceHeldError'
  }
}
