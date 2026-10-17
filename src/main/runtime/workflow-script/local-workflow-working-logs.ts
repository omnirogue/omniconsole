import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowReadCallResult } from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'
import type { OrchestrationCaller } from '../build-review/build-review-rpc-call'

const MAX_WORKER_OUTPUT = 64 * 1024

/** One worker's recent output through the orchestration boundary; never the worker's own claim. */
async function readWorkerOutput(
  callRpc: OrchestrationCaller,
  dispatch: string
): Promise<{ stdout: string; outputTruncated: boolean }> {
  const read = await callRpc<{
    source?: string
    terminal?: { tail?: string[]; truncated?: boolean }
    transcript?: { messages?: NativeChatMessage[] }
  }>('orchestration.workerRead', { dispatch, limit: 80 })
  const output =
    read.source === 'transcript'
      ? (read.transcript?.messages ?? []).map(formatWorkerTranscriptMessage).join('\n')
      : (read.terminal?.tail ?? []).join('\n')
  return {
    stdout: output.slice(-MAX_WORKER_OUTPUT),
    outputTruncated: !!read.terminal?.truncated || output.length > MAX_WORKER_OUTPUT
  }
}

function dispatchesByCall(db: Database.Database, executionId: string): Map<string, string> {
  const rows = db
    .prepare(`SELECT call_id,dispatch_id FROM local_workflow_worker_calls
      WHERE execution_id=? AND dispatch_id IS NOT NULL`)
    .all(executionId) as { call_id: string; dispatch_id: string }[]
  return new Map(rows.map((row) => [row.call_id, row.dispatch_id]))
}

/** Read worker output through the orchestration boundary for the workflow view. */
export async function withWorkingWorkflowLogs(
  db: Database.Database,
  callRpc: OrchestrationCaller,
  view: LocalWorkflowView
): Promise<LocalWorkflowView> {
  if (!view.calls.length) {
    return view
  }
  const dispatchByCall = dispatchesByCall(db, view.executionId)
  const calls = await Promise.all(
    view.calls.map(async (call) => {
      const dispatch = dispatchByCall.get(call.id)
      if (!dispatch) {
        return call
      }
      try {
        return { ...call, ...(await readWorkerOutput(callRpc, dispatch)) }
      } catch {
        return call
      }
    })
  )
  return { ...view, calls }
}

/** One working call's logs for "Details"; a call without a Dispatch has none yet. */
export async function readWorkingWorkflowCallLog(
  db: Database.Database,
  callRpc: OrchestrationCaller,
  executionId: string,
  callId: string
): Promise<LocalWorkflowReadCallResult> {
  const dispatch = dispatchesByCall(db, executionId).get(callId)
  if (!dispatch) {
    return { stdout: '', stderr: '', outputTruncated: false }
  }
  try {
    return { ...(await readWorkerOutput(callRpc, dispatch)), stderr: '', attempt: 1 }
  } catch {
    return { stdout: '', stderr: '', outputTruncated: false }
  }
}
