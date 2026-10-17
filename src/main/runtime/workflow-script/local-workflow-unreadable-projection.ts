import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { workflowEvidenceDigest } from './workflow-checkpoint-store'
import type { WorkflowExecutionOutcome } from './workflow-execution-service'

/** The execution row fields a run keeps when this build cannot project its records. */
export type UnprojectedLocalWorkflowExecution = {
  id: string
  preset: LocalWorkflowView['preset']
  fence: number
  sequence: number
  state: string
}

/** What the checkpoint store says when this build's program asks a recorded call differently. */
const CALL_IDENTITY_CHANGED = 'Workflow call identity changed'

/**
 * An interrupted run this build's program no longer replays: reconciling it found a recorded call
 * the current program would ask with other inputs. Resuming fails the same way, so it reads like a
 * finished run an earlier version recorded, never as work that needs the person.
 */
export function replaysAsEarlierVersion(input: {
  outcome?: WorkflowExecutionOutcome
  active: boolean
}): boolean {
  return (
    !input.active &&
    input.outcome?.state === 'recovery_required' &&
    (input.outcome.error ?? '').includes(CALL_IDENTITY_CHANGED)
  )
}

type RecordedRequest = { intact: boolean; prompt?: string; startedAt?: number }

/** The question a run was asked and when, from its frozen snapshot while that snapshot is intact. */
function readRecordedRequest(db: Database.Database, executionId: string): RecordedRequest {
  try {
    const row = db
      .prepare('SELECT snapshot_json,snapshot_digest FROM local_workflow_executions WHERE id=?')
      .get(executionId) as { snapshot_json: string; snapshot_digest: string } | undefined
    if (!row || workflowEvidenceDigest(row.snapshot_json) !== row.snapshot_digest) {
      return { intact: false }
    }
    const { snapshot } = JSON.parse(row.snapshot_json) as {
      snapshot?: { task?: { prompt?: unknown }; host?: { startedAt?: unknown } }
    }
    const prompt = snapshot?.task?.prompt
    const startedAt = snapshot?.host?.startedAt
    return {
      intact: true,
      ...(typeof prompt === 'string' ? { prompt } : {}),
      ...(typeof startedAt === 'number' ? { startedAt } : {})
    }
  } catch {
    return { intact: false }
  }
}

/** Whether a saved result no longer matches its digest: the records were damaged, not outgrown. */
function resultsDamaged(db: Database.Database, executionId: string): boolean {
  try {
    const calls = db
      .prepare(
        'SELECT result_json,result_digest FROM local_workflow_calls WHERE execution_id=? AND result_json IS NOT NULL'
      )
      .all(executionId) as { result_json: string; result_digest: string | null }[]
    return calls.some((call) => workflowEvidenceDigest(call.result_json) !== call.result_digest)
  } catch {
    return true
  }
}

const LIVE_STATES = ['running', 'pausing', 'stopping'] as const

/**
 * A run whose records this build cannot project. While its program still runs it keeps its state
 * and its Stop, so nothing claims it ended. Once settled it keeps only its question and reads as
 * stopped, not "Needs you": an earlier version recorded it (replay or validation no longer
 * matches) or its records are damaged (a digest no longer matches). Nothing the person does
 * brings it back, so the view offers to start it again, with the host's reasons behind Details.
 */
export function projectUnreadableLocalWorkflow(input: {
  db: Database.Database
  execution: UnprojectedLocalWorkflowExecution
  active: boolean
  reasons: readonly (string | undefined)[]
}): LocalWorkflowView {
  const { db, execution } = input
  const recorded = readRecordedRequest(db, execution.id)
  const base = {
    executionId: execution.id,
    fence: execution.fence,
    sequence: execution.sequence,
    preset: execution.preset,
    connection: 'connected' as const,
    prompt: recorded.prompt ?? '',
    startedAt: recorded.startedAt ?? 0,
    running: 0,
    queued: 0,
    reused: 0,
    stages: [],
    calls: [],
    error: [...new Set(input.reasons.filter(Boolean))].join('\n')
  }
  const live = LIVE_STATES.find((state) => state === execution.state)
  if (input.active && live) {
    return { ...base, state: live, actions: live === 'stopping' ? [] : ['stop'] }
  }
  return {
    ...base,
    state: 'cancelled',
    actions: [],
    unreadable: recorded.intact && !resultsDamaged(db, execution.id) ? 'earlier-version' : 'damaged'
  }
}
