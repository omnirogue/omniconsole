import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import { drainWorkflowControl } from './workflow-checkpoint-controls'
import { graphAdmissionClosed, graphSpecOfExecution } from './graph/graph-checkpoint'
import { workflowTerminalCall } from '../../../shared/workflow-graph-topology'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import { workflowWebStarts, type WorkflowWebStarts } from './workflow-web-starts'
import {
  assertWorkflowProcessReceiptIdentity,
  type WorkflowProcessReceiptIdentity
} from './workflow-process-receipt-identity'

/** What an attempt's card says when OmniConsole closed while its agent was working. */
export const WORKFLOW_INTERRUPTED_ERROR =
  'Interrupted: OmniConsole closed while this agent was working.'
/** The same, for an attempt that was reserved but whose agent had not started yet. */
export const WORKFLOW_INTERRUPTED_BEFORE_START =
  'Interrupted: OmniConsole closed before this agent started.'

/** An attempt a replaced owner left pending, exactly as recorded. */
export type WorkflowOrphanedAttempt = {
  id: string
  call_id: string
  fence: number
  state: string
  receipt_json: string | null
}

/**
 * Proven by the caller, never inferred from missing files: either nothing was launched, or the
 * launched process is gone (`stopped` when recovery had to end it itself).
 */
export type WorkflowInterruptedEvidence =
  | { launched: false }
  | { launched: true; groupCleanupRequired: boolean; stopped: boolean }

const PENDING_ATTEMPT_STATES = ['prepared', 'running', 'unverifiable']

/** What the store exposes of attempt records beyond a live launch. */
export type WorkflowAttempts = Pick<
  WorkflowCheckpointProcess,
  'orphanedAttempts' | 'settleInterrupted' | 'graphCallRefused' | 'webStarts'
>

type Attempt = {
  id: string
  execution_id: string
  call_id: string
  ordinal: number
  fence: number
  state: string
  receipt_json: string | null
}

/** Uses the checkpoint transaction; receipt files cannot supply their own expected identity. */
export class WorkflowCheckpointProcess {
  constructor(
    private readonly db: Database.Database,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly owned: (
      id: string,
      fence: number
    ) => { state: string; snapshot_json: string; call_limit: number }
  ) {}

  private attempt(id: string, fence: number, historical = false): Attempt {
    const attempt = this.db.prepare('SELECT * FROM local_workflow_attempts WHERE id=?').get(id) as
      | Attempt
      | undefined
    if (!attempt || (historical ? attempt.fence > fence : attempt.fence !== fence)) {
      throw new Error('Attempt fence rejected')
    }
    this.owned(attempt.execution_id, fence)
    return attempt
  }

  private verify(attempt: Attempt, identity: WorkflowProcessReceiptIdentity): void {
    assertWorkflowProcessReceiptIdentity(identity)
    if (
      identity.executionId !== attempt.execution_id ||
      identity.attemptId !== attempt.id ||
      identity.callId !== attempt.call_id ||
      identity.ordinal !== attempt.ordinal ||
      identity.fence !== attempt.fence
    ) {
      throw new Error('Prepared process identity mismatch')
    }
  }

  pendingAttempts(
    executionId: string,
    fence: number
  ): { id: string; call_id: string; fence: number }[] {
    this.owned(executionId, fence)
    return this.db
      .prepare(
        "SELECT id,call_id,fence FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable') ORDER BY call_id,ordinal"
      )
      .all(executionId) as { id: string; call_id: string; fence: number }[]
  }

  recordPreparation(id: string, fence: number, identity: WorkflowProcessReceiptIdentity): void {
    this.transaction(() => {
      const attempt = this.attempt(id, fence)
      this.verify(attempt, identity)
      if (
        attempt.state !== 'prepared' ||
        attempt.receipt_json !== null ||
        this.owned(attempt.execution_id, fence).state !== 'running'
      ) {
        throw new Error('Process preparation state rejected')
      }
      const json = JSON.stringify(identity)
      this.db
        .prepare('UPDATE local_workflow_attempts SET receipt_json=? WHERE id=?')
        .run(
          JSON.stringify({ preparedProcess: { json, digest: workflowEvidenceDigest(json) } }),
          id
        )
    })
  }

  /** Called only by the trusted adapter before entering the process runner. */
  recordNoLaunch(id: string, fence: number, reason: string): void {
    if (!reason || reason.length > 2_048) {
      throw new Error('Invalid no-launch reason')
    }
    this.transaction(() => {
      const attempt = this.attempt(id, fence)
      const execution = this.owned(attempt.execution_id, fence)
      if (attempt.state !== 'prepared' || attempt.receipt_json !== null) {
        throw new Error('No-launch settlement requires untouched prepared attempt')
      }
      this.db
        .prepare('UPDATE local_workflow_attempts SET state=?,receipt_json=? WHERE id=?')
        .run(
          execution.state === 'stopping' ? 'cancelled' : 'failed',
          JSON.stringify({ attemptId: id, noLaunch: true, reason }),
          id
        )
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
      if (['pausing', 'stopping'].includes(execution.state)) {
        const pending = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE execution_id=? AND state IN ('prepared','running','unverifiable')"
          )
          .get(attempt.execution_id) as { count: number }
        if (!pending.count) {
          const drained = execution.state === 'stopping' ? 'cancelled' : 'paused'
          this.db
            .prepare('UPDATE local_workflow_executions SET state=?,sequence=sequence+1 WHERE id=?')
            .run(drained, attempt.execution_id)
        }
      }
    })
  }

  readIdentity(id: string, fence: number): WorkflowProcessReceiptIdentity {
    const attempt = this.attempt(id, fence, true)
    const prepared = attempt.receipt_json && JSON.parse(attempt.receipt_json).preparedProcess
    if (
      !prepared ||
      typeof prepared.json !== 'string' ||
      workflowEvidenceDigest(prepared.json) !== prepared.digest
    ) {
      throw new Error('Prepared process evidence is missing or corrupt')
    }
    const identity = JSON.parse(prepared.json) as WorkflowProcessReceiptIdentity
    this.verify(attempt, identity)
    return identity
  }

  /**
   * A graph call a finishing run refused (graph-checkpoint.ts): it has no record, and the run
   * admits nothing new outside its final step. The program, its replays and the view all settle
   * such a call as skipped, so they plan the same run.
   */
  graphCallRefused(executionId: string, fence: number, callId: string): boolean {
    const execution = this.owned(executionId, fence)
    const spec = graphSpecOfExecution(execution.snapshot_json)
    if (!spec || workflowTerminalCall(spec, callId)) {
      return false
    }
    const recorded = (
      this.db
        .prepare('SELECT call_id FROM local_workflow_calls WHERE execution_id=?')
        .all(executionId) as { call_id: string }[]
    ).map((row) => row.call_id)
    return !recorded.includes(callId) && graphAdmissionClosed(spec, execution.call_limit, recorded)
  }

  /** The run's web calls that began fetching, owned by this fence (workflow-web-starts.ts). */
  webStarts(executionId: string, fence: number): WorkflowWebStarts {
    return workflowWebStarts(this.db, executionId, () => this.owned(executionId, fence))
  }

  /** Pending attempts of owners this fence replaced. Claiming the fence proved those owners dead. */
  orphanedAttempts(executionId: string, fence: number): WorkflowOrphanedAttempt[] {
    this.owned(executionId, fence)
    return this.db
      .prepare(
        "SELECT id,call_id,fence,state,receipt_json FROM local_workflow_attempts WHERE execution_id=? AND fence<? AND state IN ('prepared','running','unverifiable') ORDER BY call_id,ordinal"
      )
      .all(executionId, fence) as WorkflowOrphanedAttempt[]
  }

  /**
   * Settles an attempt whose owner died before recording its exit. Its output was never seen, so
   * it is charged like any failed attempt and the call is asked again on Resume or Retry.
   */
  settleInterrupted(
    id: string,
    fence: number,
    recorded: WorkflowOrphanedAttempt,
    evidence: WorkflowInterruptedEvidence
  ): 'failed' | 'cancelled' {
    return this.transaction(() => {
      const attempt = this.attempt(id, fence, true)
      if (
        attempt.fence >= fence ||
        attempt.fence !== recorded.fence ||
        attempt.state !== recorded.state ||
        attempt.receipt_json !== recorded.receipt_json ||
        !PENDING_ATTEMPT_STATES.includes(attempt.state)
      ) {
        throw new Error('Interrupted attempt evidence changed')
      }
      const execution = this.owned(attempt.execution_id, fence)
      if (!['pausing', 'stopping'].includes(execution.state)) {
        throw new Error('Workflow must remain closed during recovery')
      }
      const prior = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : {}
      let receipt: Record<string, unknown>
      if (evidence.launched) {
        const identity = this.readIdentity(id, fence)
        const processReceiptRef = join(identity.directory, identity.attemptId, 'launch.json')
        if (
          prior.processReceiptRef !== undefined &&
          prior.processReceiptRef !== processReceiptRef
        ) {
          throw new Error('Prepared process receipt path mismatch')
        }
        receipt = {
          ...prior,
          attemptId: id,
          processReceiptRef,
          liveness: 'exited',
          interrupted: true,
          groupCleanupRequired: evidence.groupCleanupRequired,
          ...(evidence.stopped ? { stoppedByFence: fence } : {}),
          error: WORKFLOW_INTERRUPTED_ERROR,
          recoveredByFence: fence
        }
      } else {
        if (attempt.state !== 'prepared') {
          throw new Error('A launched attempt needs process exit evidence')
        }
        receipt = {
          ...prior,
          attemptId: id,
          noLaunch: true,
          interrupted: true,
          reason: WORKFLOW_INTERRUPTED_BEFORE_START,
          recoveredByFence: fence
        }
      }
      const state = execution.state === 'stopping' ? 'cancelled' : 'failed'
      this.db
        .prepare('UPDATE local_workflow_attempts SET state=?,receipt_json=? WHERE id=?')
        .run(state, JSON.stringify(receipt), id)
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
      drainWorkflowControl(this.db, attempt.execution_id, execution.state)
      return state
    })
  }

  recordLaunch(id: string, fence: number, processReceiptRef: string): void {
    if (!processReceiptRef) {
      throw new Error('Process receipt required')
    }
    this.transaction(() => {
      const attempt = this.attempt(id, fence)
      if (
        attempt.state !== 'prepared' ||
        this.owned(attempt.execution_id, fence).state !== 'running'
      ) {
        throw new Error('Workflow admission is stopped or attempt launch state rejected')
      }
      const prior = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : {}
      if (prior.preparedProcess) {
        const identity = this.readIdentity(id, fence)
        if (processReceiptRef !== join(identity.directory, identity.attemptId, 'launch.json')) {
          throw new Error('Prepared process receipt path mismatch')
        }
      }
      this.db
        .prepare("UPDATE local_workflow_attempts SET state='running',receipt_json=? WHERE id=?")
        .run(JSON.stringify({ ...prior, attemptId: id, processReceiptRef }), id)
      // Prepared → running is visible in the projection, so watchers must see a new sequence.
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
    })
  }
}
