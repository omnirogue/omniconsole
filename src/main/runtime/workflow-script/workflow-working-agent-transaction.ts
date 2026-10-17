import type { OrchestrationDb } from '../orchestration/db'

export function workingAgentTransaction<T>(db: OrchestrationDb, work: () => T): T {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.db.exec('COMMIT')
    return result
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export function workingAgentExecutionAcceptsResult(
  db: OrchestrationDb,
  executionId: string
): boolean {
  const execution = db.db
    .prepare('SELECT state FROM local_workflow_executions WHERE id=?')
    .get(executionId) as { state: string } | undefined
  return Boolean(execution && ['running', 'pausing'].includes(execution.state))
}
