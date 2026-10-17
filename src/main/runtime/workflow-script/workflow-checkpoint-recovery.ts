import type {
  WorkflowNativeAttestationInput,
  WorkflowProgramSnapshot
} from './workflow-execution-service'
import { workflowFrozenSeat } from './workflow-program-snapshot'
import type Database from '../../sqlite/sync-database'
import type { WorkflowProgramCall } from './workflow-program-context'
import { workflowCallDigest } from './workflow-call-digest'
import type { WorkflowCheckpointProcess } from './workflow-checkpoint-process'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import { parseWorkflowNativeResult } from './workflow-native-result'
import { assertWorkflowSchemaContract } from './workflow-schema-contract'
import { commitWorkflowResult } from './workflow-result-commit'
import { drainWorkflowControl } from './workflow-checkpoint-controls'

export type WorkflowAttemptRecovery = {
  attemptId: string
  fence: number
  /** Reconstructed by the trusted bundled preset, never deserialized from RPC. */
  call: WorkflowProgramCall
  /** The same native identity check required before live result acceptance. */
  attestNativeResult: (input: WorkflowNativeAttestationInput) => void
}
type Attempt = {
  id: string
  execution_id: string
  call_id: string
  fence: number
  state: string
  receipt_json: string
}

/** A claimed owner reconciles old attempts; missing exit evidence never settles or retries them. */
export class WorkflowCheckpointRecovery {
  constructor(
    private readonly db: Database.Database,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly owned: (id: string, fence: number) => { state: string; snapshot_json: string },
    private readonly processes: WorkflowCheckpointProcess
  ) {}

  recover(input: WorkflowAttemptRecovery): 'accepted' | 'failed' | 'cancelled' {
    const attempt = this.db
      .prepare('SELECT * FROM local_workflow_attempts WHERE id=?')
      .get(input.attemptId) as Attempt | undefined
    if (
      !attempt ||
      attempt.call_id !== input.call.id ||
      attempt.fence >= input.fence ||
      !['prepared', 'running', 'unverifiable'].includes(attempt.state)
    ) {
      throw new Error('Historical workflow attempt is not recoverable')
    }
    const execution = this.owned(attempt.execution_id, input.fence)
    if (!['pausing', 'stopping'].includes(execution.state)) {
      throw new Error('Workflow must remain closed during recovery')
    }
    const snapshot = JSON.parse(execution.snapshot_json).snapshot as WorkflowProgramSnapshot
    const seat = workflowFrozenSeat(snapshot, input.call.seatId)
    if (
      snapshot.version !== 1 ||
      !seat ||
      !['claude', 'codex', 'grok', 'gemini', 'openrouter', 'ollama'].includes(seat.agent)
    ) {
      throw new Error('Recovery requires a frozen workflow seat')
    }
    const inputDigest = workflowCallDigest(input.call, JSON.stringify(seat), seat.agent)
    const call = this.db
      .prepare(
        'SELECT input_digest,quarantined FROM local_workflow_calls WHERE execution_id=? AND call_id=?'
      )
      .get(attempt.execution_id, attempt.call_id) as
      | { input_digest: string; quarantined: number }
      | undefined
    if (!call || call.input_digest !== inputDigest || call.quarantined) {
      throw new Error('Recovery call identity changed or quarantined')
    }
    const expected = this.processes.readIdentity(attempt.id, input.fence)
    const saved = readWorkflowProcessReceipt(expected)
    let parsed: ReturnType<typeof parseWorkflowNativeResult> | undefined
    let error: string | undefined
    if (execution.state !== 'stopping') {
      assertWorkflowSchemaContract(input.call.schema)
      try {
        parsed = parseWorkflowNativeResult(
          seat.agent,
          saved.result,
          input.call.schema,
          input.call.validateSemantics,
          input.call.output,
          input.call.timeoutMs
        )
        input.attestNativeResult({
          route: seat.agent,
          seat,
          executionId: attempt.execution_id,
          attemptId: attempt.id,
          parsed
        })
      } catch (cause) {
        parsed = undefined
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    return this.transaction(() => {
      const currentExecution = this.owned(attempt.execution_id, input.fence)
      const current = this.db
        .prepare('SELECT * FROM local_workflow_attempts WHERE id=?')
        .get(attempt.id) as Attempt | undefined
      const currentCall = this.db
        .prepare(
          'SELECT input_digest,quarantined FROM local_workflow_calls WHERE execution_id=? AND call_id=?'
        )
        .get(attempt.execution_id, attempt.call_id) as typeof call
      if (
        currentExecution.state !== execution.state ||
        current?.state !== attempt.state ||
        current?.fence !== attempt.fence ||
        current?.receipt_json !== attempt.receipt_json ||
        currentCall?.input_digest !== inputDigest ||
        currentCall?.quarantined
      ) {
        throw new Error('Workflow recovery evidence changed')
      }
      const state =
        currentExecution.state === 'stopping' ? 'cancelled' : parsed ? 'accepted' : 'failed'
      if (state === 'accepted') {
        commitWorkflowResult(this.db, attempt, parsed!.value)
      }
      const receipt = {
        ...saved.receipt,
        preparedProcess: JSON.parse(attempt.receipt_json).preparedProcess,
        recoveredByFence: input.fence,
        ...(parsed
          ? {
              providerSessionId: parsed.providerSessionId,
              providerRequestId: parsed.providerRequestId,
              resolvedModels: parsed.resolvedModels,
              usage: parsed.usage
            }
          : {}),
        ...(error ? { error } : {})
      }
      this.db
        .prepare('UPDATE local_workflow_attempts SET state=?,receipt_json=? WHERE id=?')
        .run(state, JSON.stringify(receipt), attempt.id)
      this.db
        .prepare('UPDATE local_workflow_executions SET sequence=sequence+1 WHERE id=?')
        .run(attempt.execution_id)
      drainWorkflowControl(this.db, attempt.execution_id, currentExecution.state)
      return state
    })
  }
}
