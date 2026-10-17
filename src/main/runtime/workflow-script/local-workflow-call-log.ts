import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowReadCallResult } from '../../../shared/local-workflow-rpc'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import { readLocalWorkflowExecution } from './local-workflow-projection'

const TERMINAL_ATTEMPTS = ['accepted', 'failed', 'cancelled']

/**
 * One call's captured stdout/stderr, read only through a verified terminal receipt: the latest
 * attempt that launched and exited. While a retry runs, that is the previous attempt, whose logs
 * explain the retry. A call with no such attempt has no captured logs yet.
 */
export function readLocalWorkflowCallLog(
  db: Database.Database,
  store: WorkflowCheckpointStore,
  executionId: string,
  callId: string
): LocalWorkflowReadCallResult {
  const row = readLocalWorkflowExecution(db, executionId)
  const attempts = db
    .prepare(
      'SELECT id,ordinal,state,receipt_json FROM local_workflow_attempts WHERE execution_id=? AND call_id=? ORDER BY ordinal DESC'
    )
    .all(executionId, callId) as {
    id: string
    ordinal: number
    state: string
    receipt_json: string | null
  }[]
  const attempt = attempts.find((entry) => {
    const receipt = entry.receipt_json ? JSON.parse(entry.receipt_json) : {}
    // An interrupted attempt's output died with its owner; nothing was captured.
    return TERMINAL_ATTEMPTS.includes(entry.state) && !receipt.noLaunch && !receipt.interrupted
  })
  if (!attempt) {
    return { stdout: '', stderr: '', outputTruncated: false }
  }
  const terminal = readWorkflowProcessReceipt(store.readProcessIdentity(attempt.id, row.fence))
  return {
    stdout: terminal.result.stdout,
    stderr: terminal.result.stderr,
    outputTruncated: Boolean(terminal.result.stdoutTruncated || terminal.result.stderrTruncated),
    attempt: attempt.ordinal
  }
}
