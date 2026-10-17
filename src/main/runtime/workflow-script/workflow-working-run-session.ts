import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { OrchestrationCaller } from '../build-review/build-review-rpc-call'
import { createDesktopCoordinator } from '../orchestration/desktop-coordinator'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  bindWorkingRun,
  getWorkingRun,
  markWorkingRunStartInFlight,
  prepareWorkingRun,
  rebindWorkingRunCoordinator,
  replacePreparedWorkingCoordinator,
  workingRunIdFromReceipt,
  type WorkingRunRow
} from './workflow-working-run-binding'

async function recoverStartingRun(
  db: OrchestrationDb,
  callRpc: OrchestrationCaller,
  row: WorkingRunRow
): Promise<WorkingRunRow> {
  const shown = await callRpc<{ state: string; receipt?: unknown }>('orchestration.requestShow', {
    request: row.run_request_id
  })
  const runId = workingRunIdFromReceipt(shown.receipt)
  if (!runId) {
    throw new Error('Working runCreate effect requires manual reconciliation')
  }
  return bindWorkingRun(db, row.execution_id, runId)
}

/** Recreate only the coordinator shell on restart; the original Run/Dispatch stays pinned. */
export async function ensureWorkingWorkflowRun(input: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  callRpc: OrchestrationCaller
  executionId: string
  snapshot: LocalWorkflowHostSnapshot
  recovering: boolean
  signal: AbortSignal
}): Promise<WorkingRunRow> {
  const { db, runtime, callRpc, executionId, snapshot, recovering, signal } = input
  const source = snapshot.host.workingSource!
  let row = getWorkingRun(db, executionId)
  if (!row) {
    const handle = await createDesktopCoordinator(
      runtime,
      snapshot.host.workspaceId,
      'Workflow coordinator',
      { launchCause: { trigger: 'workflow', reference: { workflowRunId: executionId } } }
    )
    row = prepareWorkingRun(db, {
      executionId,
      workspaceId: snapshot.host.workspaceId,
      coordinatorHandle: handle,
      sourceBase: source.sourceBase,
      sourceDiffDigest: source.sourceDiffDigest
    })
  }
  if (
    row.workspace_id !== snapshot.host.workspaceId ||
    row.source_base !== source.sourceBase ||
    row.source_diff_digest !== source.sourceDiffDigest
  ) {
    throw new Error('Working Run source or workspace changed on recovery')
  }
  if (row.state === 'prepared' && !runtime.getTerminalPaneKey(row.coordinator_handle)) {
    const handle = await createDesktopCoordinator(
      runtime,
      row.workspace_id,
      'Workflow coordinator',
      { launchCause: { trigger: 'workflow', reference: { workflowRunId: executionId } } }
    )
    row = replacePreparedWorkingCoordinator(db, executionId, handle)
  }
  if (row.state === 'prepared') {
    row = markWorkingRunStartInFlight(db, executionId)
    try {
      const created = await callRpc<{ run?: { id?: string } }>(
        'orchestration.runCreate',
        { objective: snapshot.task.prompt.slice(0, 512), from: row.coordinator_handle },
        { requestId: row.run_request_id, signal }
      )
      const runId = workingRunIdFromReceipt(created)
      if (!runId) {
        throw new Error('runCreate returned no Run identity')
      }
      row = bindWorkingRun(db, executionId, runId)
    } catch {
      row = await recoverStartingRun(db, callRpc, row)
    }
  } else if (row.state === 'starting') {
    row = await recoverStartingRun(db, callRpc, row)
  }
  if (row.state !== 'running' || !row.run_id) {
    throw new Error(`Working Run is ${row.state}; worker admission is closed`)
  }
  if (recovering || !runtime.getTerminalPaneKey(row.coordinator_handle)) {
    const handle = await createDesktopCoordinator(
      runtime,
      row.workspace_id,
      'Workflow recovery coordinator',
      { launchCause: { trigger: 'workflow', reference: { workflowRunId: executionId } } }
    )
    await callRpc('orchestration.runUse', { id: row.run_id, from: handle }, { signal })
    row = rebindWorkingRunCoordinator(db, executionId, row.run_id, handle)
  }
  return row
}
