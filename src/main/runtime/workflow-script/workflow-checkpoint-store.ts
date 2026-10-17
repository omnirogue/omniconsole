import { WorkflowCacheMissError } from './workflow-cache-miss'
import {
  WorkflowCheckpointRecovery,
  type WorkflowAttemptRecovery
} from './workflow-checkpoint-recovery'
import { commitWorkflowResult } from './workflow-result-commit'
import { claimWorkflowOwner } from './workflow-owner-claim'
import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import { WorkflowCheckpointProcess, type WorkflowAttempts } from './workflow-checkpoint-process'
import {
  assertWorkflowAttemptAdmissible,
  createWorkflowCheckpoint,
  type WorkflowCheckpointStart
} from './workflow-checkpoint-admission'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { WorkflowCheckpointControls } from './workflow-checkpoint-controls'
import type { WorkflowCallRecord, WorkflowExecutionRecord } from './workflow-checkpoint-records'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import { readWorkflowCallEvidence } from './workflow-call-evidence'

export { workflowEvidenceDigest } from './workflow-evidence-digest'

type Attempt = { id: string; execution_id: string; call_id: string; fence: number; state: string }

/** Borrows the existing orchestration connection; this store grants no execution ownership. */
export class WorkflowCheckpointStore {
  private readonly recovery: WorkflowCheckpointRecovery
  private readonly processes: WorkflowCheckpointProcess
  private readonly controls: WorkflowCheckpointControls

  constructor(private readonly db: Database.Database) {
    this.processes = new WorkflowCheckpointProcess(
      db,
      (work) => this.transaction(work),
      (id, fence) => this.owned(id, fence)
    )
    this.recovery = new WorkflowCheckpointRecovery(
      db,
      (work) => this.transaction(work),
      (id, fence) => this.owned(id, fence),
      this.processes
    )
    this.controls = new WorkflowCheckpointControls(
      db,
      (work) => this.transaction(work),
      (id, fence) => this.owned(id, fence)
    )
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // SQLITE_FULL can roll back the transaction itself; preserve the storage failure.
      }
      throw error
    }
  }

  create(input: WorkflowCheckpointStart): string {
    return createWorkflowCheckpoint(this.db, (work) => this.transaction(work), input)
  }

  claimOwner(
    executionId: string,
    expectedFence: number,
    owner: AgentSessionProcessIdentity
  ): Promise<number> {
    return claimWorkflowOwner({
      db: this.db,
      transaction: (work) => this.transaction(work),
      executionId,
      expectedFence,
      owner
    })
  }

  findStart(conversationId: string, requestId: string): string | undefined {
    return (
      this.db
        .prepare(
          'SELECT id FROM local_workflow_executions WHERE conversation_id=? AND request_id=?'
        )
        .get(conversationId, requestId) as { id: string } | undefined
    )?.id
  }

  inspect(
    executionId: string,
    fence: number
  ): { state: string; snapshot: unknown; preset: 'council' | 'discover' } {
    const execution = this.owned(executionId, fence)
    const envelope = JSON.parse(execution.snapshot_json)
    return { state: execution.state, snapshot: envelope.snapshot, preset: envelope.preset }
  }

  readCallEvidence(executionId: string, fence: number) {
    this.owned(executionId, fence)
    return readWorkflowCallEvidence(this.db, executionId)
  }

  finish(executionId: string, fence: number, success: boolean): string {
    return this.controls.finish(executionId, fence, success)
  }

  retryFailed(...args: Parameters<WorkflowCheckpointControls['retryFailed']>): void {
    this.controls.retryFailed(...args)
  }

  blockCompletedRecovery(executionId: string, fence: number): void {
    this.controls.blockCompletedRecovery(executionId, fence)
  }

  private owned(id: string, fence: number): WorkflowExecutionRecord {
    const execution = this.db
      .prepare('SELECT * FROM local_workflow_executions WHERE id=?')
      .get(id) as WorkflowExecutionRecord | undefined
    if (!execution || execution.fence !== fence) {
      throw new Error('Workflow ownership fence rejected')
    }
    if (execution.state === 'recovery_failed') {
      throw new Error('Workflow recovery is blocked')
    }
    if (workflowEvidenceDigest(execution.snapshot_json) !== execution.snapshot_digest) {
      throw new Error('Workflow snapshot integrity failure')
    }
    return execution
  }

  prepare(input: {
    executionId: string
    fence: number
    callId: string
    inputDigest: string
    reservation: number
    validate: (value: unknown) => void
    cacheOnly?: boolean
  }): { cached: unknown } | { attemptId: string; ordinal: number } {
    if (!Number.isSafeInteger(input.reservation) || input.reservation < 0) {
      throw new Error('Invalid reservation')
    }
    let corrupt = false
    try {
      return this.transaction(() => {
        const execution = this.owned(input.executionId, input.fence)
        const call = this.db
          .prepare('SELECT * FROM local_workflow_calls WHERE execution_id=? AND call_id=?')
          .get(input.executionId, input.callId) as WorkflowCallRecord | undefined
        if (call?.quarantined) {
          throw new Error('Workflow evidence quarantined')
        }
        if (call && call.input_digest !== input.inputDigest) {
          throw new Error('Workflow call identity changed')
        }
        if (call?.result_json != null) {
          try {
            if (workflowEvidenceDigest(call.result_json) !== call.result_digest) {
              throw new Error('Result digest mismatch')
            }
            const value: unknown = JSON.parse(call.result_json)
            input.validate(value)
            return { cached: value }
          } catch (error) {
            corrupt = true
            throw error
          }
        }
        if (input.cacheOnly) {
          throw new WorkflowCacheMissError(input.callId)
        }
        if (execution.state !== 'running') {
          throw new Error('Workflow admission is stopped')
        }
        const attempts = this.db
          .prepare('SELECT state FROM local_workflow_attempts WHERE execution_id=? AND call_id=?')
          .all(input.executionId, input.callId) as { state: string }[]
        if (attempts.some((attempt) => !['failed', 'cancelled'].includes(attempt.state))) {
          throw new Error('Attempt requires reconciliation')
        }
        assertWorkflowAttemptAdmissible(this.db, execution, input.callId, attempts.length)
        if (execution.budget_reserved + input.reservation > execution.budget_limit) {
          throw new Error('Workflow usage allowance exhausted')
        }
        if (!call) {
          const count = this.db
            .prepare('SELECT COUNT(*) AS count FROM local_workflow_calls WHERE execution_id=?')
            .get(input.executionId) as { count: number }
          if (count.count >= execution.call_limit) {
            throw new Error('Workflow call limit exhausted')
          }
          this.db
            .prepare(
              'INSERT INTO local_workflow_calls (execution_id,call_id,input_digest) VALUES (?,?,?)'
            )
            .run(input.executionId, input.callId, input.inputDigest)
        }
        const attemptId = randomUUID()
        const ordinal = attempts.length + 1
        this.db
          .prepare(
            `INSERT INTO local_workflow_attempts (id,execution_id,call_id,ordinal,fence,state,reservation) VALUES (?,?,?,?,?,'prepared',?)`
          )
          .run(attemptId, input.executionId, input.callId, ordinal, input.fence, input.reservation)
        this.db
          .prepare(
            'UPDATE local_workflow_executions SET budget_reserved=budget_reserved+?,sequence=sequence+1 WHERE id=?'
          )
          .run(input.reservation, input.executionId)
        return { attemptId, ordinal }
      })
    } catch (error) {
      if (corrupt) {
        this.transaction(() => {
          this.db
            .prepare(
              'UPDATE local_workflow_calls SET quarantined=1 WHERE execution_id=? AND call_id=?'
            )
            .run(input.executionId, input.callId)
          this.db
            .prepare(
              "UPDATE local_workflow_executions SET state='recovery_failed',sequence=sequence+1 WHERE id=?"
            )
            .run(input.executionId)
        })
      }
      throw error
    }
  }

  requestControl(executionId: string, fence: number, action: 'pause' | 'stop' | 'finish'): string {
    return this.controls.requestControl(executionId, fence, action)
  }

  settleFailure(...args: Parameters<WorkflowCheckpointControls['settleFailure']>): boolean {
    return this.controls.settleFailure(...args)
  }

  resume(executionId: string, fence: number): void {
    this.controls.resume(executionId, fence)
  }

  recordProcessPreparation(
    ...args: Parameters<WorkflowCheckpointProcess['recordPreparation']>
  ): void {
    this.processes.recordPreparation(...args)
  }

  recordNoLaunch(...args: Parameters<WorkflowCheckpointProcess['recordNoLaunch']>): void {
    this.processes.recordNoLaunch(...args)
  }

  pendingAttempts(executionId: string, fence: number) {
    return this.processes.pendingAttempts(executionId, fence)
  }

  readProcessIdentity(...args: Parameters<WorkflowCheckpointProcess['readIdentity']>) {
    return this.processes.readIdentity(...args)
  }

  recoverAttempt(input: WorkflowAttemptRecovery): 'accepted' | 'failed' | 'cancelled' {
    return this.recovery.recover(input)
  }

  /** Orphans a replaced owner left pending, their settlement, and graph calls a run refused. */
  get attempts(): WorkflowAttempts {
    return this.processes
  }

  recordLaunch(...args: Parameters<WorkflowCheckpointProcess['recordLaunch']>): void {
    this.processes.recordLaunch(...args)
  }

  accept(
    attemptId: string,
    fence: number,
    value: unknown,
    receipt: { attemptId: string; processReceiptRef: string; liveness: 'exited' },
    validate: (value: unknown) => void
  ): boolean {
    return this.transaction(() => {
      const attempt = this.db
        .prepare('SELECT * FROM local_workflow_attempts WHERE id=?')
        .get(attemptId) as Attempt | undefined
      if (!attempt || attempt.fence !== fence) {
        throw new Error('Attempt fence rejected')
      }
      const execution = this.owned(attempt.execution_id, fence)
      if (!['running', 'pausing'].includes(execution.state) || attempt.state !== 'running') {
        return false
      }
      if (
        receipt.attemptId !== attemptId ||
        receipt.liveness !== 'exited' ||
        !receipt.processReceiptRef
      ) {
        throw new Error('Terminal attempt receipt required')
      }
      const launch = this.db
        .prepare('SELECT receipt_json FROM local_workflow_attempts WHERE id=?')
        .get(attemptId) as { receipt_json: string }
      if (JSON.parse(launch.receipt_json).processReceiptRef !== receipt.processReceiptRef) {
        throw new Error('Process receipt mismatch')
      }
      validate(value)
      commitWorkflowResult(this.db, attempt, value)
      this.db
        .prepare("UPDATE local_workflow_attempts SET state='accepted',receipt_json=? WHERE id=?")
        .run(
          JSON.stringify({
            ...receipt,
            preparedProcess: JSON.parse(launch.receipt_json).preparedProcess
          }),
          attemptId
        )
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
      this.controls.drainControl(attempt.execution_id, execution.state)
      return true
    })
  }
}
