import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function getTaskHubBinding(db: OrchestrationDb, taskId: string): string | undefined {
  const binding = db.db
    .prepare(
      `SELECT COALESCE(tasks.hub_task_id, runs.hub_task_id) AS hub_task_id
       FROM tasks JOIN runs ON runs.id = tasks.run_id WHERE tasks.id = ?`
    )
    .get(taskId) as { hub_task_id: string | null } | undefined
  return binding?.hub_task_id ?? undefined
}

export function refuseHubBusinessMutation(taskId: string, hubTaskId: string): never {
  throw new OrchestrationError(
    'hub_task_read_only',
    `Task ${taskId} is a projection of omnios card ${hubTaskId}. Change business state through https://console.example.com or the person's omni-console MCP.`,
    { taskId, hubTaskId, omniosUrl: 'https://console.example.com' }
  )
}

export function assertLocalDecisionGateAuthority(
  db: OrchestrationDb,
  taskId: string,
  decisionScope?: 'execution' | 'business' | null
): void {
  const hubTaskId = getTaskHubBinding(db, taskId)
  if (hubTaskId && decisionScope !== 'execution') {
    refuseHubBusinessMutation(taskId, hubTaskId)
  }
  if (decisionScope === 'business') {
    throw new OrchestrationError(
      'hub_admission_required',
      'Business decisions require an omnios card; create or adopt one through https://console.example.com first.'
    )
  }
}
