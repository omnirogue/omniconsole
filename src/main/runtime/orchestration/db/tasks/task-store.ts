import type Database from '../../../../sqlite/sync-database'
import type { TaskStatus, TaskRow } from '../../types'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../shared/orchestration-task-display'
import { LEGACY_RUN_ID } from '../contract-constants'
import { generateId } from '../generated-id'
import type { TaskRuntimeLineageRow } from '../run-list-page'
import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { reconcileTaskDependents } from './task-dependency-stranding'

// ── Tasks ──

type TaskCreation = {
  spec: string
  taskTitle?: string
  displayName?: string
  deps?: string[]
  parentId?: string
  createdByTerminalHandle?: string
  createdByPaneKey?: string
  createdByProcessIncarnation?: string
  createdByRunGeneration?: number
  runId?: string
}

export function createTask(this: OrchestrationDb, task: TaskCreation): TaskRow {
  return insertTask.call(this, task)
}

// Only explicit launch/run admission imports this function. It cannot introduce a local
// dependency graph or another business identity, and is never attached to the DB/RPC API.
export function createHubTaskProjection(
  db: OrchestrationDb,
  projection: { runId: string; hubTaskId: string; title?: string; nextAction?: string | null }
): TaskRow {
  const run = db.getRun(projection.runId)
  if (!run?.hub_task_id || run.hub_task_id !== projection.hubTaskId) {
    throw new Error('A matching admitted run is required for a hub task projection.')
  }
  return insertTask.call(
    db,
    {
      runId: run.id,
      spec: projection.nextAction || projection.title || projection.hubTaskId,
      taskTitle: projection.title
    },
    projection.hubTaskId
  )
}

function insertTask(
  this: OrchestrationDb,
  task: TaskCreation,
  projectionHubTaskId: string | null = null
): TaskRow {
  const runId = task.runId ?? LEGACY_RUN_ID
  this.requireRun(runId)
  if (task.parentId) {
    const parent = this.getTask(task.parentId)
    if (!parent || parent.run_id !== runId) {
      throw new Error(`Parent task ${task.parentId} must belong to run ${runId}`)
    }
  }
  for (const depId of task.deps ?? []) {
    const dependency = this.getTask(depId)
    if (!dependency || dependency.run_id !== runId) {
      throw new Error(`Dependency task ${depId} must belong to run ${runId}`)
    }
  }
  const id = generateId('task')
  const depsJson = JSON.stringify(task.deps ?? [])
  const display = buildOrchestrationTaskDisplayMetadata({
    spec: task.spec,
    taskTitle: task.taskTitle,
    displayName: task.displayName
  })
  // Authority and readiness are evaluated by the insertion's write transaction.
  // An earlier read transaction could block upgrading after another connection
  // completes a dependency; a separate authority check could race hub admission.
  const insertion = this.db
    .prepare(
      `INSERT INTO tasks (
         id, run_id, parent_id, created_by_terminal_handle, created_by_pane_key,
         created_by_process_incarnation, created_by_run_generation,
         task_title, display_name, spec, status, deps
       ) SELECT
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN EXISTS (
           SELECT 1
           FROM json_each(?) requested
           LEFT JOIN tasks dependency ON dependency.id = requested.value
           WHERE dependency.id IS NULL
              OR dependency.run_id <> ?
              OR dependency.status <> 'completed'
         ) THEN 'pending' ELSE 'ready' END,
         ?
       FROM runs WHERE id = ? AND hub_task_id IS ?`
    )
    .run(
      id,
      runId,
      task.parentId ?? null,
      task.createdByTerminalHandle ?? null,
      task.createdByPaneKey ?? null,
      task.createdByProcessIncarnation ?? null,
      task.createdByRunGeneration ?? null,
      display.taskTitle || null,
      display.displayName || null,
      task.spec,
      depsJson,
      runId,
      depsJson,
      runId,
      projectionHubTaskId
    )
  if (!insertion.changes) {
    const run = this.getRun(runId)
    if (run?.hub_task_id && projectionHubTaskId === null) {
      throw new OrchestrationError(
        'hub_task_read_only',
        `Run ${run.id} is bound to omnios card ${run.hub_task_id}. Create or change business tasks and dependencies through https://console.example.com or the person's omni-console MCP. Local workers must use the existing card projection.`,
        { runId: run.id, hubTaskId: run.hub_task_id, omniosUrl: 'https://console.example.com' }
      )
    }
    throw new Error('A matching run authority is required to insert a task projection.')
  }
  return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow
}

// Why: return the active creator Dispatch proof with the Task read; runtime still owns pane/process currency.
export function getTask(this: OrchestrationDb, id: string): TaskRow | undefined
export function getTask(
  this: OrchestrationDb,
  id: string,
  dispatchRunId: string
): TaskRuntimeLineageRow | undefined
export function getTask(
  this: OrchestrationDb,
  id: string,
  dispatchRunId?: string
): TaskRow | TaskRuntimeLineageRow | undefined {
  if (dispatchRunId === undefined) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  }
  return this.db
    .prepare(
      `SELECT t.*,
         creator.id AS creator_dispatch_id,
         creator.run_id AS creator_dispatch_run_id,
         creator.assignee_pane_key AS creator_dispatch_pane_key,
         creator.process_incarnation AS creator_dispatch_process_incarnation
       FROM tasks t
       LEFT JOIN dispatch_contexts creator ON creator.rowid = (
         SELECT candidate.rowid
         FROM dispatch_contexts candidate
         WHERE candidate.assignee_handle = t.created_by_terminal_handle
           AND candidate.run_id = ?
           AND candidate.status IN ('pending', 'dispatched')
         ORDER BY candidate.rowid DESC
         LIMIT 1
       )
       WHERE t.id = ?`
    )
    .get(dispatchRunId, id) as TaskRuntimeLineageRow | undefined
}

export function listTasks(
  this: OrchestrationDb,
  filter?: { status?: TaskStatus; ready?: boolean; runId?: string }
): TaskRow[] {
  const runWhere = filter?.runId ? 'run_id = ? AND ' : ''
  const runParams: Database.BindValue[] = filter?.runId ? [filter.runId] : []
  if (filter?.ready) {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = 'ready' ORDER BY created_at`)
      .all(...runParams) as TaskRow[]
  }
  if (filter?.status) {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE ${runWhere}status = ? ORDER BY created_at`)
      .all(...runParams, filter.status) as TaskRow[]
  }
  if (filter?.runId) {
    return this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at')
      .all(filter.runId) as TaskRow[]
  }
  return this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[]
}

// Why: the correlated indexed lookup avoids materializing every retained Dispatch before filtering Tasks.
export function listTasksWithDispatch(
  this: OrchestrationDb,
  filter?: {
    status?: TaskStatus
    ready?: boolean
    runId?: string
  }
): (TaskRow & {
  assignee_handle: string | null
  dispatch_id: string | null
})[] {
  const whereClauses: string[] = []
  const params: Database.BindValue[] = []
  if (filter?.runId) {
    whereClauses.push('t.run_id = ?')
    params.push(filter.runId)
  }
  if (filter?.ready) {
    whereClauses.push("t.status = 'ready'")
  } else if (filter?.status) {
    whereClauses.push('t.status = ?')
    params.push(filter.status)
  }
  const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
  const sql = `
    SELECT
      t.*,
      d.assignee_handle AS assignee_handle,
      d.id              AS dispatch_id
    FROM tasks t
    LEFT JOIN dispatch_contexts d ON d.rowid = (
      SELECT candidate.rowid
      FROM dispatch_contexts candidate
      WHERE candidate.task_id = t.id
        AND candidate.status IN ('pending', 'dispatched')
      ORDER BY candidate.rowid DESC
      LIMIT 1
    )
    ${where}
    ORDER BY t.created_at
  `
  return this.db.prepare(sql).all(...params) as (TaskRow & {
    assignee_handle: string | null
    dispatch_id: string | null
  })[]
}

// Why: runs in the status-update transaction, so a completed task never leaves its ready children unpromoted.
export function promoteReadyTasks(this: OrchestrationDb, completedTaskId: string): void {
  reconcileTaskDependents(this, completedTaskId)
}

export type TaskStoreMethods = {
  createTask: typeof createTask
  getTask: typeof getTask
  listTasks: typeof listTasks
  listTasksWithDispatch: typeof listTasksWithDispatch
  promoteReadyTasks: typeof promoteReadyTasks
}

export function attachTaskStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTask,
    getTask,
    listTasks,
    listTasksWithDispatch,
    promoteReadyTasks
  })
}
