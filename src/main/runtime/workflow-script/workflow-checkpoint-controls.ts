import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type Database from '../../sqlite/sync-database'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'
import {
  WORKFLOW_SUPERSEDED_CALL_SQL,
  workflowSettlesExhaustedCalls,
  workflowSettlesSupersededCalls
} from './workflow-checkpoint-admission'
import { graphHasQuarantinedCalls, graphSpecOfExecution } from './graph/graph-checkpoint'
import {
  workflowFinishReserve,
  workflowTerminalCall
} from '../../../shared/workflow-graph-topology'

type Attempt = { id: string; execution_id: string; fence: number; state: string }

/** Control mutations share the checkpoint transaction and ownership checks. */
export class WorkflowCheckpointControls {
  constructor(
    private readonly db: Database.Database,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly owned: (
      id: string,
      fence: number
    ) => { state: string; snapshot_json: string; attempt_limit: number; call_limit: number }
  ) {}

  private assertNoActiveSibling(executionId: string): void {
    const sibling = this.db
      .prepare(`SELECT other.id FROM local_workflow_executions AS current
        JOIN local_workflow_executions AS other ON other.conversation_id=current.conversation_id
        WHERE current.id=? AND other.id<>current.id
          AND other.state NOT IN ('completed','cancelled','failed') LIMIT 1`)
      .get(executionId)
    if (sibling) {
      throw new Error('Another workflow is unfinished in this conversation')
    }
  }

  requestControl(executionId: string, fence: number, action: 'pause' | 'stop' | 'finish'): string {
    return this.transaction(() => {
      const execution = this.owned(executionId, fence)
      if (['completed', 'cancelled', 'failed'].includes(execution.state)) {
        return execution.state
      }
      if (action === 'finish') {
        this.finishEarly(executionId, execution)
        return execution.state
      }
      // Stop dominates a concurrent pause; neither action invents process exit.
      const state = execution.state === 'stopping' || action === 'stop' ? 'stopping' : 'pausing'
      this.db
        .prepare('UPDATE local_workflow_executions SET state=?,sequence=sequence+1 WHERE id=?')
        .run(state, executionId)
      return this.drainControl(executionId, state)
    })
  }

  /**
   * Finish now: the run admits no new call outside its final step, so the agents already at work
   * finish and the final step reports on what they found. Only ever lowers the call limit.
   */
  private finishEarly(
    executionId: string,
    execution: { snapshot_json: string; call_limit: number }
  ): void {
    const spec = graphSpecOfExecution(execution.snapshot_json)
    const finish = spec && workflowFinishReserve(spec)
    if (!finish) {
      throw new Error('This workflow cannot finish early.')
    }
    const recorded = (
      this.db
        .prepare('SELECT call_id FROM local_workflow_calls WHERE execution_id=?')
        .all(executionId) as { call_id: string }[]
    ).filter((row) => !workflowTerminalCall(spec, row.call_id)).length
    const limit = Math.min(execution.call_limit, recorded + finish.reserve)
    this.db
      .prepare('UPDATE local_workflow_executions SET call_limit=?,sequence=sequence+1 WHERE id=?')
      .run(limit, executionId)
  }

  drainControl(executionId: string, state: string): string {
    return drainWorkflowControl(this.db, executionId, state)
  }

  settleFailure(
    attemptId: string,
    fence: number,
    receipt: { attemptId: string; processReceiptRef: string; liveness: 'exited' },
    error: string
  ): boolean {
    return this.transaction(() => {
      const attempt = this.db
        .prepare('SELECT * FROM local_workflow_attempts WHERE id=?')
        .get(attemptId) as (Attempt & { receipt_json: string | null }) | undefined
      if (!attempt || attempt.fence !== fence) {
        throw new Error('Attempt fence rejected')
      }
      const execution = this.owned(attempt.execution_id, fence)
      if (!['running', 'unverifiable'].includes(attempt.state)) {
        return false
      }
      if (
        receipt.attemptId !== attemptId ||
        receipt.liveness !== 'exited' ||
        !receipt.processReceiptRef ||
        !attempt.receipt_json ||
        JSON.parse(attempt.receipt_json).processReceiptRef !== receipt.processReceiptRef
      ) {
        throw new Error('Matching terminal attempt receipt required')
      }
      this.db.prepare('UPDATE local_workflow_attempts SET state=?,receipt_json=? WHERE id=?').run(
        execution.state === 'stopping' ? 'cancelled' : 'failed',
        JSON.stringify({
          ...receipt,
          error,
          preparedProcess: JSON.parse(attempt.receipt_json).preparedProcess
        }),
        attemptId
      )
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
      this.drainControl(attempt.execution_id, execution.state)
      return true
    })
  }

  resume(executionId: string, fence: number): void {
    this.transaction(() => {
      const execution = this.owned(executionId, fence)
      if (execution.state !== 'paused') {
        throw new Error('Only a drained paused workflow can resume')
      }
      this.assertNoActiveSibling(executionId)
      const pending = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable')"
        )
        .get(executionId) as { count: number }
      if (pending.count) {
        throw new Error('Attempt requires reconciliation')
      }
      this.db
        .prepare(
          "UPDATE local_workflow_executions SET state='running',sequence=sequence+1 WHERE id=?"
        )
        .run(executionId)
    })
  }

  retryFailed(executionId: string, fence: number, placement?: WorkflowPlacement): void {
    this.transaction(() => {
      const execution = this.owned(executionId, fence)
      if (execution.state !== 'failed') {
        throw new Error('Only a failed workflow can retry')
      }
      this.assertNoActiveSibling(executionId)
      const pending = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable')"
        )
        .get(executionId) as { count: number }
      if (pending.count) {
        throw new Error('Attempt requires reconciliation before retry')
      }
      const allowance = this.db
        .prepare(
          'SELECT budget_limit,budget_reserved,attempt_limit FROM local_workflow_executions WHERE id=?'
        )
        .get(executionId) as {
        budget_limit: number
        budget_reserved: number
        attempt_limit: number
      }
      if (allowance.budget_reserved >= allowance.budget_limit) {
        throw new Error('Workflow host-attempt allowance is exhausted')
      }
      if (!hasWorkflowRetryableCalls(this.db, executionId, allowance.attempt_limit)) {
        throw new Error('One or more failed workflow calls have no remaining attempt')
      }
      if (placement) {
        const envelope = JSON.parse(execution.snapshot_json)
        envelope.snapshot.host = { ...envelope.snapshot.host, placement }
        const json = JSON.stringify(envelope)
        this.db
          .prepare(
            'UPDATE local_workflow_executions SET snapshot_json=?,snapshot_digest=? WHERE id=?'
          )
          .run(json, workflowEvidenceDigest(json), executionId)
      }
      this.db
        .prepare(
          "UPDATE local_workflow_executions SET state='paused',sequence=sequence+1 WHERE id=?"
        )
        .run(executionId)
    })
  }

  finish(executionId: string, fence: number, success: boolean): string {
    return this.transaction(() => {
      const execution = this.owned(executionId, fence)
      const pending = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable')"
        )
        .get(executionId) as { count: number }
      if (pending.count) {
        throw new Error('Workflow attempts still require exit reconciliation')
      }
      if (execution.state !== 'running') {
        return this.drainControl(executionId, execution.state)
      }
      if (success && graphSpecOfExecution(execution.snapshot_json)) {
        if (graphHasQuarantinedCalls(this.db, executionId)) {
          throw new Error('Workflow has unresolved results')
        }
      } else if (success) {
        // A settling program already finished around calls whose attempts ran out, and Council 6
        // around answers and rankings a later stage was keyed without.
        const settles = workflowSettlesExhaustedCalls(execution.snapshot_json) ? 1 : 0
        const superseded = workflowSettlesSupersededCalls(execution.snapshot_json) ? 1 : 0
        const calls = this.db
          .prepare(
            `SELECT COUNT(*) AS count, SUM(CASE WHEN c.quarantined=1 OR (c.accepted_attempt_id IS NULL AND (?=0 OR
              (SELECT COUNT(*) FROM local_workflow_attempts AS a
                WHERE a.execution_id=c.execution_id AND a.call_id=c.call_id) < ?)
              AND (?=0 OR NOT ${WORKFLOW_SUPERSEDED_CALL_SQL}))
              THEN 1 ELSE 0 END) AS unresolved
            FROM local_workflow_calls AS c WHERE c.execution_id=?`
          )
          .get(settles, execution.attempt_limit, superseded, executionId) as {
          count: number
          unresolved: number | null
        }
        if (!calls.count || calls.unresolved) {
          throw new Error('Workflow has unresolved results')
        }
      }
      const state = success ? 'completed' : 'failed'
      this.db
        .prepare('UPDATE local_workflow_executions SET state=?,sequence=sequence+1 WHERE id=?')
        .run(state, executionId)
      return state
    })
  }

  blockCompletedRecovery(executionId: string, fence: number): void {
    this.transaction(() => {
      const execution = this.owned(executionId, fence)
      if (execution.state !== 'completed') {
        throw new Error('Only completed workflow recovery can be blocked here')
      }
      this.db
        .prepare(
          "UPDATE local_workflow_executions SET state='recovery_failed',sequence=sequence+1 WHERE id=?"
        )
        .run(executionId)
    })
  }
}

export function drainWorkflowControl(
  db: Database.Database,
  executionId: string,
  state: string
): string {
  if (!['pausing', 'stopping'].includes(state)) {
    return state
  }
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable')"
    )
    .get(executionId) as { count: number }
  if (pending.count) {
    return state
  }
  // Writable workers can outlive a result submission. Do not declare a pause or
  // stop drained until each possible workerStart effect has a released resource.
  const workingPending = db
    .prepare(`SELECT COUNT(*) AS count
    FROM local_workflow_worker_calls c
    LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id=c.dispatch_id
    WHERE c.execution_id=? AND c.state<>'prepared'
      AND (c.dispatch_id IS NULL OR r.release_state IS NULL OR r.release_state<>'released')`)
    .get(executionId) as { count: number }
  if (workingPending.count) {
    return state
  }
  const drained = state === 'pausing' ? 'paused' : 'cancelled'
  db.prepare('UPDATE local_workflow_executions SET state=?,sequence=sequence+1 WHERE id=?').run(
    drained,
    executionId
  )
  return drained
}
