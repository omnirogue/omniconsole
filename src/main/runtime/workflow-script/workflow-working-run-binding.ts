import { randomUUID } from 'node:crypto'
import type { OrchestrationDb } from '../orchestration/db'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import { workingAgentTransaction } from './workflow-working-agent-transaction'
import { workingAgentCallNeedsArtifacts } from './workflow-working-agent-artifact-policy'

export type WorkingRunRow = {
  execution_id: string
  workspace_id: string
  coordinator_handle: string
  run_request_id: string
  run_id: string | null
  source_base: string
  source_diff_digest: string
  result_json: string | null
  result_digest: string | null
  finished_at: string | null
  state: 'prepared' | 'starting' | 'running' | 'completed' | 'failed' | 'unverifiable'
}

type RunMutation = { run?: { id?: string }; accepted?: { run?: { id?: string } } }

export function workingRunIdFromReceipt(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const receipt = value as RunMutation
  return receipt.run?.id ?? receipt.accepted?.run?.id
}

export function getWorkingRun(db: OrchestrationDb, executionId: string): WorkingRunRow | undefined {
  const row = db.db
    .prepare('SELECT * FROM local_workflow_working_runs WHERE execution_id=?')
    .get(executionId) as WorkingRunRow | undefined
  if (
    row &&
    (row.result_json === null
      ? row.result_digest !== null
      : workflowEvidenceDigest(row.result_json) !== row.result_digest)
  ) {
    throw new Error('Working Run result evidence changed')
  }
  return row
}

/** Persist source and one runCreate mutation identity before any orchestration mutation. */
export function prepareWorkingRun(
  db: OrchestrationDb,
  input: {
    executionId: string
    workspaceId: string
    coordinatorHandle: string
    sourceBase: string
    sourceDiffDigest: string
  }
): WorkingRunRow {
  if (
    !input.workspaceId ||
    !input.coordinatorHandle ||
    !/^[a-f0-9]{40,64}$/.test(input.sourceBase) ||
    !/^[a-f0-9]{64}$/.test(input.sourceDiffDigest)
  ) {
    throw new Error('Working Run source, workspace, or coordinator evidence is invalid')
  }
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
      execution.state !== 'running' ||
      JSON.parse(execution.snapshot_json)?.snapshot?.capability?.mode !== 'working-agent'
    ) {
      throw new Error('Working Run execution is missing, changed, or not admitted')
    }
    const previous = getWorkingRun(db, input.executionId)
    if (previous) {
      if (
        previous.workspace_id !== input.workspaceId ||
        previous.coordinator_handle !== input.coordinatorHandle ||
        previous.source_base !== input.sourceBase ||
        previous.source_diff_digest !== input.sourceDiffDigest
      ) {
        throw new Error('Working Run identity changed; reconcile its original runCreate request')
      }
      return previous
    }
    db.db
      .prepare(`INSERT INTO local_workflow_working_runs
        (execution_id,workspace_id,coordinator_handle,run_request_id,source_base,source_diff_digest,state)
        VALUES (?,?,?,?,?,?,'prepared')`)
      .run(
        input.executionId,
        input.workspaceId,
        input.coordinatorHandle,
        randomUUID(),
        input.sourceBase,
        input.sourceDiffDigest
      )
    return getWorkingRun(db, input.executionId)!
  })
}

/** After this transition, an unknown response must be resolved through the same request ID. */
export function markWorkingRunStartInFlight(
  db: OrchestrationDb,
  executionId: string
): WorkingRunRow {
  return workingAgentTransaction(db, () => {
    const row = getWorkingRun(db, executionId)
    if (!row || row.state !== 'prepared') {
      throw new Error('Working Run start requires original-request reconciliation')
    }
    db.db
      .prepare("UPDATE local_workflow_working_runs SET state='starting' WHERE execution_id=?")
      .run(executionId)
    return getWorkingRun(db, executionId)!
  })
}

/** No runCreate has been sent yet; a lost shell coordinator can be replaced safely. */
export function replacePreparedWorkingCoordinator(
  db: OrchestrationDb,
  executionId: string,
  coordinatorHandle: string
): WorkingRunRow {
  return workingAgentTransaction(db, () => {
    const row = getWorkingRun(db, executionId)
    if (!row || row.state !== 'prepared' || !coordinatorHandle) {
      throw new Error('Only a prepared Working Run may replace its coordinator')
    }
    db.db
      .prepare('UPDATE local_workflow_working_runs SET coordinator_handle=? WHERE execution_id=?')
      .run(coordinatorHandle, executionId)
    return getWorkingRun(db, executionId)!
  })
}

/** Invoke only after orchestration.runUse has bound the existing Run to this new live pane. */
export function rebindWorkingRunCoordinator(
  db: OrchestrationDb,
  executionId: string,
  runId: string,
  coordinatorHandle: string
): WorkingRunRow {
  return workingAgentTransaction(db, () => {
    const row = getWorkingRun(db, executionId)
    const run = db.getRun(runId)
    if (
      !row ||
      row.run_id !== runId ||
      row.state !== 'running' ||
      !run ||
      run.origin !== 'personal' ||
      run.hub_task_id ||
      run.coordinator_handle !== coordinatorHandle
    ) {
      throw new Error('Working Run coordinator rebind receipt changed')
    }
    db.db
      .prepare('UPDATE local_workflow_working_runs SET coordinator_handle=? WHERE execution_id=?')
      .run(coordinatorHandle, executionId)
    return getWorkingRun(db, executionId)!
  })
}

export function bindWorkingRun(
  db: OrchestrationDb,
  executionId: string,
  runId: string
): WorkingRunRow {
  return workingAgentTransaction(db, () => {
    const row = getWorkingRun(db, executionId)
    const run = db.getRun(runId)
    if (
      !row ||
      !run ||
      run.origin !== 'personal' ||
      run.hub_task_id ||
      run.coordinator_handle !== row.coordinator_handle ||
      (row.run_id && row.run_id !== runId) ||
      !['starting', 'running'].includes(row.state)
    ) {
      throw new Error('Working Run receipt does not match its local coordinator')
    }
    db.db
      .prepare(
        "UPDATE local_workflow_working_runs SET run_id=?,state='running' WHERE execution_id=?"
      )
      .run(runId, executionId)
    return getWorkingRun(db, executionId)!
  })
}

/** Commit the program return only after every writable Task completed and its resource released. */
export function finishWorkingRun(
  db: OrchestrationDb,
  executionId: string,
  fence: number,
  result: unknown
): WorkingRunRow {
  return workingAgentTransaction(db, () => {
    const execution = db.db
      .prepare('SELECT fence,state FROM local_workflow_executions WHERE id=?')
      .get(executionId) as { fence: number; state: string } | undefined
    const row = getWorkingRun(db, executionId)
    if (
      !execution ||
      execution.fence !== fence ||
      execution.state !== 'running' ||
      row?.state !== 'running'
    ) {
      throw new Error('Working Run completion ownership or state changed')
    }
    const calls = db.db
      .prepare(`SELECT c.call_id,c.state,c.result_json,c.result_digest,
      c.artifact_digest,c.child_worktree_id,t.status AS task_status,r.release_state
      FROM local_workflow_worker_calls c
      LEFT JOIN tasks t ON t.id=c.task_id
      LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id=c.dispatch_id
      WHERE c.execution_id=?`)
      .all(executionId) as {
      call_id: string
      state: string
      result_json: string | null
      result_digest: string | null
      artifact_digest: string | null
      child_worktree_id: string | null
      task_status: string | null
      release_state: string | null
    }[]
    if (
      !calls.length ||
      calls.some(
        (call) =>
          call.state !== 'accepted' ||
          !call.result_json ||
          workflowEvidenceDigest(call.result_json) !== call.result_digest ||
          (workingAgentCallNeedsArtifacts(call.call_id) &&
            (!call.child_worktree_id || !/^[a-f0-9]{64}$/.test(call.artifact_digest ?? ''))) ||
          call.task_status !== 'completed' ||
          call.release_state !== 'released'
      )
    ) {
      throw new Error('Working Run still has unresolved or unreleased Dispatches')
    }
    const resultJson = JSON.stringify(result)
    if (!resultJson) {
      throw new Error('Working Run result is not serializable')
    }
    db.db
      .prepare(`UPDATE local_workflow_working_runs
      SET result_json=?,result_digest=?,finished_at=datetime('now'),state='completed'
      WHERE execution_id=?`)
      .run(resultJson, workflowEvidenceDigest(resultJson), executionId)
    db.db
      .prepare(
        "UPDATE local_workflow_executions SET state='completed',sequence=sequence+1 WHERE id=?"
      )
      .run(executionId)
    return getWorkingRun(db, executionId)!
  })
}
