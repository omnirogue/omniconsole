import type { TaskRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { validateHubBinding } from './hub-binding-validation'

// Called only with a card snapshot fetched through the authenticated backoffice client.
export function refreshHubTaskProjection(
  this: OrchestrationDb,
  params: {
    taskId: string
    hubTaskId: string
    hubStateRevision: number
    hubNextAction: string | null
  }
): TaskRow {
  validateHubBinding(params)
  this.db.exec('SAVEPOINT refresh_hub_projection')
  try {
    const task = this.getTask(params.taskId)
    if (!task || task.hub_task_id !== params.hubTaskId) {
      throw new Error(
        'The task must already be bound to this omnios card before refreshing its projection.'
      )
    }
    if (task.hub_state_revision != null && params.hubStateRevision < task.hub_state_revision) {
      throw new Error('Stale hub revision; refresh the card through omnios.')
    }
    if (
      task.hub_state_revision === params.hubStateRevision &&
      task.hub_next_action != null &&
      task.hub_next_action !== params.hubNextAction
    ) {
      throw new Error('Conflicting projection for the same hub revision; refresh through omnios.')
    }
    this.db
      .prepare(`UPDATE tasks SET hub_state_revision = ?, hub_next_action = ? WHERE hub_task_id = ?
    AND (hub_state_revision IS NULL OR hub_state_revision <= ?)`)
      .run(params.hubStateRevision, params.hubNextAction, params.hubTaskId, params.hubStateRevision)
    this.db
      .prepare(`UPDATE runs SET hub_state_revision = ? WHERE hub_task_id = ?
    AND (hub_state_revision IS NULL OR hub_state_revision < ?)`)
      .run(params.hubStateRevision, params.hubTaskId, params.hubStateRevision)
    this.db.exec('RELEASE refresh_hub_projection')
    return this.getTask(task.id) as TaskRow
  } catch (error) {
    this.db.exec('ROLLBACK TO refresh_hub_projection')
    this.db.exec('RELEASE refresh_hub_projection')
    throw error
  }
}

export type HubTaskProjectionMethods = { refreshHubTaskProjection: typeof refreshHubTaskProjection }

export function attachHubTaskProjection(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { refreshHubTaskProjection })
}
