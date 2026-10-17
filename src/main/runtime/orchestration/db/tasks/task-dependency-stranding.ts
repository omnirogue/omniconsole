import type { TaskRow, TaskStatus } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * A dependent whose dependency failed is `blocked` with this reason in `result`. The
 * prefix is what tells it apart from a gate-blocked or start-unknown task, so it is
 * never reworded without migrating the rows that carry it.
 */
export const DEPENDENCY_FAILED_REASON_PREFIX = 'Cannot start: dependency'

export function isDependencyStrandedTask(task: Pick<TaskRow, 'status' | 'result'>): boolean {
  return (
    task.status === 'blocked' && Boolean(task.result?.startsWith(DEPENDENCY_FAILED_REASON_PREFIX))
  )
}

function taskLabel(task: TaskRow): string {
  return task.display_name || task.task_title || task.id
}

function dependencyVerdict(
  db: OrchestrationDb,
  task: TaskRow
): { status: TaskStatus; result: string | null } {
  const deps = JSON.parse(task.deps) as string[]
  const rows = deps.map((id) => db.getTask(id))
  const failed = rows.find((row): row is TaskRow =>
    Boolean(row && (row.status === 'failed' || isDependencyStrandedTask(row)))
  )
  if (failed) {
    // A transitively stranded task names the dependency that actually failed.
    return {
      status: 'blocked',
      result:
        failed.status === 'failed'
          ? `${DEPENDENCY_FAILED_REASON_PREFIX} "${taskLabel(failed)}" failed. Retry it to continue.`
          : failed.result
    }
  }
  return {
    status: rows.every((row) => row?.status === 'completed') ? 'ready' : 'pending',
    result: null
  }
}

/**
 * Re-derive the readiness of every waiting dependent after `changedTaskId` moved: promote it
 * when all dependencies completed, strand it when one failed, and put it back to pending when a
 * retried dependency no longer failed. Callers run this inside the status-change transaction.
 */
export function reconcileTaskDependents(db: OrchestrationDb, changedTaskId: string): void {
  const visited = new Set<string>()
  const queue = [changedTaskId]
  const dependentsOf = db.db.prepare(
    `SELECT dependent.* FROM tasks changed
     JOIN tasks dependent ON dependent.run_id = changed.run_id
     WHERE changed.id = ?
       AND dependent.status IN ('pending', 'blocked')
       AND EXISTS (SELECT 1 FROM json_each(dependent.deps) WHERE value = changed.id)
     ORDER BY dependent.created_at`
  )
  const update = db.db.prepare(
    'UPDATE tasks SET status = ?, result = ? WHERE id = ? AND status = ?'
  )
  while (queue.length > 0) {
    const taskId = queue.shift()!
    if (visited.has(taskId)) {
      continue
    }
    visited.add(taskId)
    for (const dependent of dependentsOf.all(taskId) as TaskRow[]) {
      const stranded = isDependencyStrandedTask(dependent)
      if (dependent.status === 'blocked' && !stranded) {
        continue
      }
      const next = dependencyVerdict(db, dependent)
      const result = next.result ?? (stranded ? null : dependent.result)
      if (next.status === dependent.status && result === dependent.result) {
        continue
      }
      update.run(next.status, result, dependent.id, dependent.status)
      queue.push(dependent.id)
    }
  }
}
