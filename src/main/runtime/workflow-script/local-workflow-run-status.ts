import { readFileSync } from 'node:fs'
import type Database from '../../sqlite/sync-database'
import type {
  LocalWorkflowRunStatus,
  LocalWorkflowRunStatusSeat
} from '../../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { readLocalWorkflowExecution } from './local-workflow-projection'

type AttemptRow = {
  id: string
  call_id: string
  ordinal: number
  state: string
  receipt_json: string | null
}

/** The host and folder a dispatched attempt's launch.json names; absent for one launched here. */
function dispatchEvidence(ref: unknown): { host?: string; directory?: string } {
  if (typeof ref !== 'string') {
    return {}
  }
  try {
    const launch = JSON.parse(readFileSync(ref, 'utf8').slice(0, 64 * 1024)) as {
      dispatch?: { host?: unknown; directory?: unknown }
    }
    return {
      ...(typeof launch.dispatch?.host === 'string' ? { host: launch.dispatch.host } : {}),
      ...(typeof launch.dispatch?.directory === 'string'
        ? { directory: launch.dispatch.directory }
        : {})
    }
  } catch {
    return {}
  }
}

/**
 * One run by id for `omni workflow status`: the projected view's state and placement, plus every
 * attempt that launched with where it ran and the provider session it answered in.
 */
export function localWorkflowRunStatus(
  db: Database.Database,
  view: LocalWorkflowView
): LocalWorkflowRunStatus {
  const row = readLocalWorkflowExecution(db, view.executionId)
  const [worktreeId, conversationId] = JSON.parse(row.conversation_id) as [string, string]
  const calls = new Map(view.calls.map((call) => [call.id, call]))
  const attempts = db
    .prepare(
      'SELECT id, call_id, ordinal, state, receipt_json FROM local_workflow_attempts WHERE execution_id=? ORDER BY call_id, ordinal'
    )
    .all(view.executionId) as AttemptRow[]
  const seats = attempts.flatMap((attempt): LocalWorkflowRunStatusSeat[] => {
    let receipt: Record<string, unknown> = {}
    try {
      receipt = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : {}
    } catch {
      receipt = {}
    }
    if (receipt.noLaunch === true || typeof receipt.processReceiptRef !== 'string') {
      return []
    }
    const call = calls.get(attempt.call_id)
    const dispatch = dispatchEvidence(receipt.processReceiptRef)
    return [
      {
        callId: attempt.call_id,
        attempt: attempt.ordinal,
        state: attempt.state,
        ...(call?.agent ? { route: call.agent } : {}),
        ...(call?.model ? { model: call.model } : {}),
        host: dispatch.host ?? 'this computer',
        ...(dispatch.directory ? { remoteDirectory: dispatch.directory } : {}),
        ...(typeof receipt.providerSessionId === 'string'
          ? { sessionId: receipt.providerSessionId }
          : {}),
        ...(typeof receipt.error === 'string' ? { error: receipt.error.slice(0, 500) } : {})
      }
    ]
  })
  return {
    executionId: view.executionId,
    worktreeId,
    conversationId,
    preset: view.preset,
    state: view.state,
    prompt: view.prompt,
    startedAt: view.startedAt,
    ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}),
    ...(view.error ? { error: view.error } : {}),
    ...(view.placement ? { placement: view.placement } : {}),
    ...(view.requestedBy ? { requestedBy: view.requestedBy } : {}),
    ...(view.requestedById ? { requestedById: view.requestedById } : {}),
    ...(view.request ? { request: view.request } : {}),
    seats,
    ...(view.graphRun?.verified
      ? { verified: { count: view.graphRun.verified.length, items: view.graphRun.verified } }
      : {})
  }
}
