import { randomUUID } from 'node:crypto'
import type { JsonSchema } from '../../../shared/json-schema-validate'
import {
  describeJsonSchemaProblems,
  validateJsonSchema
} from '../../../shared/json-schema-validate'
import type { OrchestrationDb } from '../orchestration/db'
import type {
  WorkflowProgramCall,
  WorkflowProgramSemanticContract
} from './workflow-program-context'
import { assertWorkflowSchemaContract } from './workflow-schema-contract'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { WorkingAgentCallRow } from './workflow-working-agent-call-types'
export type { WorkingAgentCallRow } from './workflow-working-agent-call-types'
import { workingAgentCallNeedsArtifacts } from './workflow-working-agent-artifact-policy'
import {
  workingAgentExecutionAcceptsResult,
  workingAgentTransaction
} from './workflow-working-agent-transaction'
import {
  assertWorkingAgentSemanticContract,
  workingAgentSemanticProblem
} from './workflow-working-agent-semantics'

export const WORKING_AGENT_CAPABILITY_REVISION = 'working-agent-v1'

/** Bind a Task before workerStart, so even an immediate worker report sees the result gate. */
export function prepareWorkingAgentCall(
  db: OrchestrationDb,
  input: {
    executionId: string
    runId: string
    taskId: string
    workspaceId: string
    sourceBase: string
    sourceDiffDigest: string
    seatFingerprint: string
    call: WorkflowProgramCall
  }
): WorkingAgentCallRow {
  if (
    !input.workspaceId ||
    !input.sourceBase ||
    !input.seatFingerprint ||
    !/^[a-f0-9]{64}$/.test(input.sourceDiffDigest)
  ) {
    throw new Error('Working-agent source, workspace, or seat evidence is missing')
  }
  assertWorkflowSchemaContract(input.call.schema)
  assertWorkingAgentSemanticContract(input.call.semantic)
  const schemaJson = JSON.stringify(input.call.schema)
  const semanticJson = JSON.stringify(input.call.semantic)
  const inputDigest = workflowEvidenceDigest(
    JSON.stringify({
      callId: input.call.id,
      prompt: input.call.prompt,
      dependencies: input.call.dependencies,
      schema: input.call.schema,
      semantic: input.call.semantic,
      seat: input.seatFingerprint,
      workspaceId: input.workspaceId,
      sourceBase: input.sourceBase,
      sourceDiffDigest: input.sourceDiffDigest,
      capabilityRevision: WORKING_AGENT_CAPABILITY_REVISION
    })
  )
  return workingAgentTransaction(db, () => {
    const execution = db.db
      .prepare(
        'SELECT snapshot_json,snapshot_digest,state FROM local_workflow_executions WHERE id=?'
      )
      .get(input.executionId) as
      | { snapshot_json: string; snapshot_digest: string; state: string }
      | undefined
    if (
      !execution ||
      workflowEvidenceDigest(execution.snapshot_json) !== execution.snapshot_digest ||
      !['running', 'pausing'].includes(execution.state)
    ) {
      throw new Error('Working-agent execution is missing, changed, or stopped')
    }
    const snapshot = JSON.parse(execution.snapshot_json) as {
      snapshot?: { capability?: { mode?: string; revision?: number } }
    }
    if (
      snapshot.snapshot?.capability?.mode !== 'working-agent' ||
      snapshot.snapshot.capability.revision !== 1
    ) {
      throw new Error('Execution did not admit working-agent capability')
    }
    const task = db.db.prepare('SELECT run_id FROM tasks WHERE id=?').get(input.taskId) as
      | { run_id: string }
      | undefined
    if (!task || task.run_id !== input.runId) {
      throw new Error('Working-agent Task is not in the selected Run')
    }
    const previous = db.db
      .prepare('SELECT * FROM local_workflow_worker_calls WHERE execution_id=? AND call_id=?')
      .get(input.executionId, input.call.id) as WorkingAgentCallRow | undefined
    if (previous) {
      if (
        previous.task_id !== input.taskId ||
        previous.run_id !== input.runId ||
        previous.input_digest !== inputDigest
      ) {
        throw new Error('Working-agent call identity changed; never redispatch a writable call')
      }
      return previous
    }
    if (execution.state !== 'running') {
      throw new Error('Working workflow is pausing; no new writable call may start')
    }
    const requestId = randomUUID()
    db.db
      .prepare(`INSERT INTO local_workflow_worker_calls
      (execution_id,call_id,run_id,task_id,start_request_id,workspace_id,input_digest,source_base,source_diff_digest,capability_revision,schema_json,schema_digest,semantic_json,semantic_digest,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')`)
      .run(
        input.executionId,
        input.call.id,
        input.runId,
        input.taskId,
        requestId,
        input.workspaceId,
        inputDigest,
        input.sourceBase,
        input.sourceDiffDigest,
        WORKING_AGENT_CAPABILITY_REVISION,
        schemaJson,
        workflowEvidenceDigest(schemaJson),
        semanticJson,
        workflowEvidenceDigest(semanticJson)
      )
    return db.db
      .prepare('SELECT * FROM local_workflow_worker_calls WHERE execution_id=? AND call_id=?')
      .get(input.executionId, input.call.id) as WorkingAgentCallRow
  })
}

/** Persist launch intent before the RPC; a restart must inspect this same request, never allocate another. */
export function markWorkingAgentStartInFlight(
  db: OrchestrationDb,
  executionId: string,
  callId: string
): WorkingAgentCallRow {
  return workingAgentTransaction(db, () => {
    const execution = db.db
      .prepare('SELECT state FROM local_workflow_executions WHERE id=?')
      .get(executionId) as { state: string } | undefined
    const row = db.db
      .prepare('SELECT * FROM local_workflow_worker_calls WHERE execution_id=? AND call_id=?')
      .get(executionId, callId) as WorkingAgentCallRow | undefined
    if (!execution || execution.state !== 'running' || !row || row.state !== 'prepared') {
      throw new Error('Working-agent start is already in flight or requires reconciliation')
    }
    db.db
      .prepare(
        "UPDATE local_workflow_worker_calls SET state='starting' WHERE execution_id=? AND call_id=?"
      )
      .run(executionId, callId)
    return { ...row, state: 'starting' }
  })
}

/** A Dispatch can be adopted after a lost workerStart response only if it belongs to the prebound Task. */
export function bindWorkingAgentDispatch(
  db: OrchestrationDb,
  taskId: string,
  dispatchId: string
): WorkingAgentCallRow {
  return workingAgentTransaction(db, () => {
    const row = db.db
      .prepare('SELECT * FROM local_workflow_worker_calls WHERE task_id=?')
      .get(taskId) as WorkingAgentCallRow | undefined
    const dispatch = db.db
      .prepare('SELECT run_id,task_id FROM dispatch_contexts WHERE id=?')
      .get(dispatchId) as { run_id: string; task_id: string } | undefined
    if (
      !row ||
      !dispatch ||
      dispatch.task_id !== row.task_id ||
      dispatch.run_id !== row.run_id ||
      (row.dispatch_id && row.dispatch_id !== dispatchId) ||
      !['starting', 'running', 'accepted'].includes(row.state)
    ) {
      throw new Error('Working-agent Dispatch does not match its admitted Task')
    }
    db.db
      .prepare(
        "UPDATE local_workflow_worker_calls SET dispatch_id=?,state=CASE WHEN state='starting' THEN 'running' ELSE state END WHERE task_id=?"
      )
      .run(dispatchId, taskId)
    return db.db
      .prepare('SELECT * FROM local_workflow_worker_calls WHERE task_id=?')
      .get(taskId) as WorkingAgentCallRow
  })
}

/** Undefined means this Dispatch is an ordinary non-workflow worker. */
export function getWorkingAgentCallForDispatch(
  db: OrchestrationDb,
  dispatchId: string
): WorkingAgentCallRow | undefined {
  const row = db.db
    .prepare(`SELECT c.* FROM local_workflow_worker_calls c
    JOIN dispatch_contexts d ON d.task_id=c.task_id AND d.run_id=c.run_id
    WHERE d.id=?`)
    .get(dispatchId) as WorkingAgentCallRow | undefined
  if (row && row.dispatch_id && row.dispatch_id !== dispatchId) {
    throw new Error('Working-agent Task is bound to a different Dispatch')
  }
  return row
}

/** Same-Dispatch tool boundary: invalid JSON/schema/semantics returns defects without settling. */
export function acceptWorkingAgentResult(
  db: OrchestrationDb,
  dispatchId: string,
  value: unknown,
  artifactDigest?: string
): { accepted: boolean; duplicate?: boolean; problems?: string } {
  return workingAgentTransaction(db, () => {
    const row = getWorkingAgentCallForDispatch(db, dispatchId)
    if (!row) {
      return { accepted: false, problems: 'Dispatch is not bound to a working-agent call' }
    }
    if (!workingAgentExecutionAcceptsResult(db, row.execution_id)) {
      return {
        accepted: false,
        problems: 'Workflow execution is stopped; this Dispatch cannot accept a result'
      }
    }
    if (!['starting', 'running', 'accepted'].includes(row.state)) {
      return { accepted: false, problems: `Working-agent call is ${row.state}` }
    }
    if (
      workingAgentCallNeedsArtifacts(row.call_id) &&
      (!artifactDigest || !/^[a-f0-9]{64}$/.test(artifactDigest) || !row.child_worktree_id)
    ) {
      return {
        accepted: false,
        problems: 'Candidate artifacts require a pinned child worktree and digest'
      }
    }
    const dispatch = db.db
      .prepare('SELECT status FROM dispatch_contexts WHERE id=?')
      .get(dispatchId) as { status: string } | undefined
    if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) {
      return { accepted: false, problems: 'Working-agent Dispatch is no longer active' }
    }
    if (row.dispatch_id === null) {
      const other = db.db
        .prepare('SELECT 1 FROM dispatch_contexts WHERE task_id=? AND id<>? LIMIT 1')
        .get(row.task_id, dispatchId)
      if (other) {
        return { accepted: false, problems: 'Working-agent Task has another Dispatch' }
      }
    }
    if (workflowEvidenceDigest(row.schema_json) !== row.schema_digest) {
      throw new Error('Working-agent schema evidence changed')
    }
    const schema = JSON.parse(row.schema_json) as JsonSchema
    assertWorkflowSchemaContract(schema)
    const defects = validateJsonSchema(schema, value)
    if (defects.length) {
      return { accepted: false, problems: describeJsonSchemaProblems(defects) }
    }
    const semantic = JSON.parse(row.semantic_json) as WorkflowProgramSemanticContract
    if (workflowEvidenceDigest(row.semantic_json) !== row.semantic_digest) {
      throw new Error('Working-agent semantic evidence changed')
    }
    assertWorkingAgentSemanticContract(semantic)
    const problem = workingAgentSemanticProblem(semantic, value)
    if (problem) {
      return { accepted: false, problems: problem }
    }
    const resultJson = JSON.stringify(value)
    const digest = workflowEvidenceDigest(resultJson)
    if (row.state === 'accepted') {
      if (row.dispatch_id !== dispatchId) {
        return { accepted: false, problems: 'Working-agent result belongs to another Dispatch' }
      }
      if (row.result_digest === digest && row.artifact_digest === (artifactDigest ?? null)) {
        return { accepted: true, duplicate: true }
      }
      // The same live worker may correct its report or changed files before worker_done.
      db.db
        .prepare(`UPDATE local_workflow_worker_calls
        SET result_json=?,result_digest=?,artifact_digest=?,result_revision=result_revision+1
        WHERE task_id=? AND dispatch_id=? AND state='accepted'`)
        .run(resultJson, digest, artifactDigest ?? null, row.task_id, dispatchId)
      return { accepted: true }
    }
    db.db
      .prepare(`UPDATE local_workflow_worker_calls
      SET dispatch_id=?,result_json=?,result_digest=?,artifact_digest=?,result_revision=result_revision+1,state='accepted'
      WHERE task_id=? AND state IN ('starting','running')`)
      .run(dispatchId, resultJson, digest, artifactDigest ?? null, row.task_id)
    return { accepted: true }
  })
}
