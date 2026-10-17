import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
import type { OrchestrationDb } from './db'
import type { RunRow, TaskRow } from './types'
import { createHubTaskProjection } from './db/tasks/task-store'
export { assertUnboundHubTerminalLaunch } from '../../pty/hub-task-launch-admission'

export function admitHubLinkedLaunch(
  db: OrchestrationDb,
  params: {
    linkedItem?: Pick<
      WorkspaceLinkedItem,
      'title' | 'hubTaskId' | 'hubStateRevision' | 'hubNextAction'
    > | null
    launchHubTaskId?: string
    coordinatorHandle: string
    coordinatorPaneKey: string
    coordinatorProcessIncarnation?: string
  }
): { run: RunRow; task: TaskRow } | null {
  const item = params.linkedItem
  if (!item?.hubTaskId || !params.launchHubTaskId) {
    return null
  }
  if (item.hubTaskId !== params.launchHubTaskId) {
    throw new Error('The launched agent and its admitted omnios card differ.')
  }
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const current = db.getCurrentRunForPane(params.coordinatorPaneKey)
    if (current?.hub_task_id && current.hub_task_id !== item.hubTaskId) {
      throw new Error('The continuing session is already bound to another omnios card.')
    }
    const run = current?.hub_task_id
      ? current
      : db.createRun({
          objective: item.title || item.hubTaskId,
          coordinatorHandle: params.coordinatorHandle,
          coordinatorPaneKey: params.coordinatorPaneKey,
          coordinatorProcessIncarnation: params.coordinatorProcessIncarnation,
          hubTaskId: item.hubTaskId,
          hubStateRevision: item.hubStateRevision
        })
    let task = db
      .listTasks({ runId: run.id })
      .find((candidate) => candidate.hub_task_id === item.hubTaskId)
    task ??= createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: item.hubTaskId,
      nextAction: item.hubNextAction,
      title: item.title
    })
    if (
      item.hubStateRevision !== undefined &&
      (task.hub_state_revision == null || task.hub_state_revision <= item.hubStateRevision)
    ) {
      task = db.refreshHubTaskProjection({
        taskId: task.id,
        hubTaskId: item.hubTaskId,
        hubStateRevision: item.hubStateRevision,
        hubNextAction: item.hubNextAction ?? null
      })
    }
    if (
      item.hubStateRevision === undefined &&
      task.hub_state_revision == null &&
      task.hub_next_action == null &&
      item.hubNextAction !== undefined
    ) {
      db.db
        .prepare('UPDATE tasks SET hub_next_action = ? WHERE id = ?')
        .run(item.hubNextAction, task.id)
      task = db.getTask(task.id) as TaskRow
    }
    db.db.exec('COMMIT')
    return { run: db.getRun(run.id) as RunRow, task }
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
