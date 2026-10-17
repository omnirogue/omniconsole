import { readWorkerCompletionPolicy } from '../../../../../shared/orchestration-worker-completion-policy'
import type { DeliveryRow, MessageRow } from '../../types'
import { mailboxRecipientPredicate } from '../messages/run-mailbox-recipient'
import {
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  RUN_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'
import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'

function object(value: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function acceptedDispatch(
  db: OrchestrationDb,
  delivery: DeliveryRow,
  message: MessageRow
): string | null {
  if (
    message.type !== 'worker_done' ||
    message.run_id !== delivery.run_id ||
    message.to_handle !== `run:${delivery.run_id}` ||
    message.delivery_contract !== 'current_delivery'
  ) {
    return null
  }
  const payload = object(message.payload)
  if (
    typeof payload?.taskId !== 'string' ||
    typeof payload.dispatchId !== 'string' ||
    (payload.outcome !== 'succeeded' && payload.outcome !== 'failed')
  ) {
    return null
  }
  const task = db.getTask(payload.taskId)
  const dispatch = db.getDispatchContextById(payload.dispatchId)
  const worker = db.getWorkerDispatch(payload.dispatchId)
  const report = object(task?.result ?? null)
  const status = payload.outcome === 'succeeded' ? 'completed' : 'failed'
  if (
    task?.run_id !== delivery.run_id ||
    task.status !== status ||
    dispatch?.run_id !== delivery.run_id ||
    dispatch.task_id !== task.id ||
    dispatch.status !== status ||
    worker?.state !== payload.outcome ||
    !readWorkerCompletionPolicy(worker.start_options) ||
    report?.provenance !== 'worker_report' ||
    report.messageId !== message.id ||
    report.outcome !== payload.outcome ||
    db.getFederatedDispatch(dispatch.id)
  ) {
    return null
  }
  return dispatch.id
}

// Checked by the owner immediately before close, including after archive capture.
// Late mail or child work must not slip through an asynchronous archive capture.
export function workerHasOpenObligations(db: OrchestrationDb, dispatchId: string): boolean {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  const workerPaneKey = dispatch?.assignee_pane_key
  if (!dispatch || !worker || !workerPaneKey) {
    return true
  }
  const openQuestion = db.db
    .prepare(`SELECT 1 FROM question_threads WHERE dispatch_id = ? AND status = 'pending' LIMIT 1`)
    .get(dispatchId)
  // Mail for a Run this worker coordinates uses the Run mailbox recipient rule, so follow-up
  // mail still addressed to a settled child Dispatch holds cleanup until the worker reads it.
  const unreadMail = db.db
    .prepare(`SELECT 1 FROM messages WHERE read = 0
      AND delivery_contract = 'current_delivery' AND to_handle IN (?, ?) LIMIT 1`)
    .get(worker.agent_terminal_handle, `dispatch:${dispatchId}`)
  const coordinatedRuns = db.db
    .prepare(`SELECT id, coordinator_pane_key FROM runs WHERE ${RUN_PANE_KEY_MATCH_SUFFIX_SQL} = ?`)
    .all(paneKeyMatchSuffix(workerPaneKey)) as {
    id: string
    coordinator_pane_key: string
  }[]
  const unreadRunMail = coordinatedRuns.some((run) => {
    if (!isEquivalentPaneKey(run.coordinator_pane_key, workerPaneKey)) {
      return false
    }
    const recipient = mailboxRecipientPredicate(`run:${run.id}`)
    return Boolean(
      db.db
        .prepare(`SELECT 1 FROM messages WHERE read = 0
        AND delivery_contract = 'current_delivery' AND ${recipient.sql} LIMIT 1`)
        .get(...recipient.params)
    )
  })
  const createdTasks = db.db
    .prepare('SELECT id, created_by_pane_key FROM tasks WHERE created_by_process_incarnation = ?')
    .all(dispatch.process_incarnation) as { id: string; created_by_pane_key: string | null }[]
  const createdTaskIds = createdTasks
    .filter(
      (task) =>
        task.created_by_pane_key !== null &&
        isEquivalentPaneKey(task.created_by_pane_key, workerPaneKey)
    )
    .map((task) => task.id)
  const activeDescendant = db.db
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM tasks WHERE
           (run_id = ? AND parent_id = ?) OR id IN (SELECT value FROM json_each(?))
         UNION SELECT child.id FROM tasks child JOIN descendants parent ON child.parent_id = parent.id
       ) SELECT 1 FROM tasks WHERE id IN (SELECT id FROM descendants)
         AND status IN ('pending', 'ready', 'dispatched', 'blocked') LIMIT 1`
    )
    .get(dispatch.run_id, dispatch.task_id, JSON.stringify(createdTaskIds))
  return Boolean(openQuestion || unreadMail || unreadRunMail || activeDescendant)
}

// Runs in the acknowledgment transaction; self-report and delivery alone never authorize cleanup.
export function requestAcceptedWorkerTerminalReleases(
  db: OrchestrationDb,
  delivery: DeliveryRow
): void {
  for (const message of db.getDeliveryMessages(delivery)) {
    const dispatchId = acceptedDispatch(db, delivery, message)
    if (!dispatchId) {
      continue
    }
    // Acceptance survives temporary obligations; the owner rechecks them before every close.
    // Retention, user takeover, external terminals and immediate reuse stay with their owners.
    db.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'requested',
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             updated_at = datetime('now')
         WHERE owner_dispatch_id = ? AND ownership_state = 'owned'
           AND release_state = 'not_requested' AND retained_reason IS NULL`
      )
      .run(dispatchId)
  }
}

// Older acknowledgments permanently retained workers for temporary obligations. Repair only
// that exact legacy reason, with the original accepted report and unchanged launch authority.
export function restoreAcceptedWorkerTerminalReleaseRequests(db: OrchestrationDb): number {
  const candidates = db.db
    .prepare(
      `SELECT * FROM worker_terminal_resources WHERE ownership_state = 'owned'
         AND release_state = 'retained' AND retained_reason = 'pending_obligations'`
    )
    .all() as WorkerTerminalResourceRow[]
  if (!candidates.length) {
    return 0
  }
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const restored = restoreLegacyObligationHolds(db, candidates)
    db.db.exec('COMMIT')
    return restored
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

function restoreLegacyObligationHolds(
  db: OrchestrationDb,
  candidates: WorkerTerminalResourceRow[]
): number {
  let restored = 0
  for (const candidate of candidates) {
    const resource = db.getWorkerTerminalResource(candidate.id)
    if (
      !resource ||
      resource.ownership_state !== 'owned' ||
      resource.release_state !== 'retained' ||
      resource.retained_reason !== 'pending_obligations'
    ) {
      continue
    }
    if (
      db.getWorkerTerminalArchive(resource.owner_dispatch_id) &&
      db.getWorkerTerminalReleaseClosePhase(resource.owner_dispatch_id, resource.id) !== 'prepared'
    ) {
      continue
    }
    const dispatch = db.getDispatchContextById(resource.owner_dispatch_id)
    const worker = db.getWorkerDispatch(resource.owner_dispatch_id)
    if (
      !dispatch ||
      !worker ||
      !resource.pane_key ||
      !resource.process_incarnation ||
      resource.terminal_handle !== worker.agent_terminal_handle ||
      resource.worktree_id !== worker.worktree_id ||
      resource.pane_key !== dispatch.assignee_pane_key ||
      resource.process_incarnation !== dispatch.process_incarnation ||
      object(resource.host_scope)?.kind !== 'local' ||
      db.workerTerminalResourceHasIdentityConflict(resource.id)
    ) {
      continue
    }
    const report = object(db.getTask(dispatch.task_id)?.result ?? null)
    const message = typeof report?.messageId === 'string' && db.getMessageById(report.messageId)
    if (!message) {
      continue
    }
    const delivery = db.db
      .prepare(
        `SELECT d.* FROM deliveries d WHERE d.run_id = ? AND d.status = 'acknowledged'
           AND d.acknowledged_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(d.message_ids) WHERE value = ?)
         ORDER BY d.acknowledged_at LIMIT 1`
      )
      .get(dispatch.run_id, message.id) as DeliveryRow | undefined
    if (!delivery || acceptedDispatch(db, delivery, message) !== dispatch.id) {
      continue
    }
    restored += Number(
      db.db
        .prepare(
          `UPDATE worker_terminal_resources SET release_state = 'requested',
             retained_reason = NULL,
             release_requested_at = COALESCE(release_requested_at, ?),
             updated_at = datetime('now')
           WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
             AND release_state = 'retained' AND retained_reason = 'pending_obligations'`
        )
        .run(delivery.acknowledged_at, resource.id, dispatch.id).changes
    )
  }
  return restored
}
