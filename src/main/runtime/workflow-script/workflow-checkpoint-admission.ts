import {
  isAgentSessionProcessIdentity,
  type AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  COUNCIL_MAX_MEMBERS,
  DISCOVER_MAX_AGENTS_CEILING
} from '../../../shared/local-workflow-draft'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { WorkflowExecutionRecord } from './workflow-checkpoint-records'
import { WORKFLOW_MAX_CALLS } from '../../../shared/workflow-graph'
import {
  COUNCIL_REVISION,
  DISCOVER_REVISION,
  GRAPH_PROGRAM_REVISION
} from './workflow-program-revisions'
import { assertGraphAttemptAdmissible, graphSpecOfExecution } from './graph/graph-checkpoint'
import { isSupportedAuditRevision } from './audit/audit-program-revision'

export type WorkflowCheckpointStart = {
  owner?: AgentSessionProcessIdentity
  conversationId: string
  requestId: string
  snapshot: unknown
  preset: 'council' | 'discover'
  fence: number
  attemptLimit: number
  callLimit: number
  budgetLimit: number
}

/**
 * Absolute per-revision call ceiling; the host derives the exact limit from the draft. The working
 * programs (Council 5, Discover 6) keep the ceilings they were admitted under.
 */
export function workflowCallCeiling(preset: 'council' | 'discover', snapshot: unknown): number {
  const pinned = snapshot as {
    audit?: { version?: unknown }
    councilProgramRevision?: unknown
    discoverProgramRevision?: unknown
    graphProgramRevision?: unknown
  } | null
  if (pinned?.audit) {
    if (
      preset !== 'discover' ||
      !isSupportedAuditRevision(pinned.audit.version) ||
      pinned.graphProgramRevision !== undefined
    ) {
      throw new Error('Unsupported audit workflow snapshot')
    }
    return WORKFLOW_MAX_CALLS
  }
  if (pinned?.graphProgramRevision === GRAPH_PROGRAM_REVISION) {
    return WORKFLOW_MAX_CALLS
  }
  if (preset === 'council') {
    // Revision 6: every member answers, every non-Google member ranks, plus the chairman.
    return pinned?.councilProgramRevision === COUNCIL_REVISION ? COUNCIL_MAX_MEMBERS * 2 + 1 : 7
  }
  const revision = pinned?.discoverProgramRevision
  if (revision === DISCOVER_REVISION) {
    return DISCOVER_MAX_AGENTS_CEILING
  }
  return revision === 4 || revision === 5 || revision === 6 ? 30 : 28
}

/** Which program that degrades instead of dying, if any, the admitted snapshot pinned. */
function pinnedProgram(snapshotJson: string): {
  council: boolean
  discover: boolean
  graph: boolean
} {
  try {
    const envelope = JSON.parse(snapshotJson) as {
      preset?: unknown
      snapshot?: {
        councilProgramRevision?: unknown
        discoverProgramRevision?: unknown
        graphProgramRevision?: unknown
      } | null
    }
    return {
      graph: envelope.snapshot?.graphProgramRevision === GRAPH_PROGRAM_REVISION,
      council:
        envelope.preset === 'council' &&
        envelope.snapshot?.councilProgramRevision === COUNCIL_REVISION,
      discover:
        envelope.preset === 'discover' &&
        envelope.snapshot?.discoverProgramRevision === DISCOVER_REVISION
    }
  } catch {
    return { council: false, discover: false, graph: false }
  }
}

/**
 * Programs that degrade instead of dying (Discover 7, Council 6): they finish around a call whose
 * persisted attempts ran out and replay it as the same null, so such a call neither blocks
 * completion nor Retry of the calls that still have room. Legacy and working revisions require
 * every call and keep the original rules.
 */
export function workflowSettlesExhaustedCalls(snapshotJson: string): boolean {
  const pinned = pinnedProgram(snapshotJson)
  return pinned.council || pinned.discover || pinned.graph
}

/**
 * Council 6 also settles a call that still has attempts: each stage is keyed on the results the
 * stage before it settled with, so once a later stage has recorded a call, an answer or ranking
 * still without a result replays as the same null. It then neither blocks completion nor counts
 * for Retry, which reruns only the chairman. A call no later stage was keyed on may run again.
 */
export function workflowSettlesSupersededCalls(snapshotJson: string): boolean {
  return pinnedProgram(snapshotJson).council
}

/**
 * Council 6 stage of a call id (presets/council-v6.ts): answers, rankings, then the chairman.
 * Prefixes are compared with substr, not GLOB: the statement cache skips SQL containing `*`.
 */
const councilStage = (column: string): string =>
  `(CASE WHEN substr(${column},1,7)='answer/' THEN 1 WHEN substr(${column},1,5)='rank/' THEN 2 WHEN ${column}='chair/final' THEN 3 ELSE 0 END)`

/** SQL over the call row `c`: an answer or ranking that a later Council 6 stage was keyed without. */
export const WORKFLOW_SUPERSEDED_CALL_SQL = `(${councilStage('c.call_id')} IN (1, 2) AND EXISTS (
  SELECT 1 FROM local_workflow_calls AS later WHERE later.execution_id=c.execution_id
    AND ${councilStage('later.call_id')} > ${councilStage('c.call_id')}))`

/** Refuses a new attempt for a call whose replay must stay the null it already settled as. */
export function assertWorkflowAttemptAdmissible(
  db: Database.Database,
  execution: Pick<WorkflowExecutionRecord, 'id' | 'snapshot_json' | 'attempt_limit' | 'call_limit'>,
  callId: string,
  attempts: number
): void {
  if (attempts >= execution.attempt_limit) {
    throw new Error('Persisted attempt budget exhausted')
  }
  // The cached query runs first: it is cheaper than parsing the snapshot for every call.
  const superseded = db
    .prepare(
      `SELECT 1 AS found FROM (SELECT ? AS execution_id, ? AS call_id) AS c WHERE ${WORKFLOW_SUPERSEDED_CALL_SQL}`
    )
    .get(execution.id, callId)
  if (superseded && workflowSettlesSupersededCalls(execution.snapshot_json)) {
    throw new Error('A later council stage was recorded without this result')
  }
  const graph = graphSpecOfExecution(execution.snapshot_json)
  if (graph) {
    // A call's first attempt is what creates its record.
    assertGraphAttemptAdmissible(db, execution, graph, callId, attempts === 0)
  }
}

export function createWorkflowCheckpoint(
  db: Database.Database,
  transaction: <T>(work: () => T) => T,
  input: WorkflowCheckpointStart
): string {
  if (input.owner && !isAgentSessionProcessIdentity(input.owner)) {
    throw new Error('Invalid workflow owner identity')
  }
  const json = JSON.stringify({
    preset: input.preset,
    attemptLimit: input.attemptLimit,
    callLimit: input.callLimit,
    budgetLimit: input.budgetLimit,
    snapshot: input.snapshot
  })
  const digest = workflowEvidenceDigest(json)
  if (input.callLimit > workflowCallCeiling(input.preset, input.snapshot)) {
    throw new Error('Preset call ceiling exceeded')
  }
  return transaction(() => {
    const previous = db
      .prepare(
        'SELECT id, snapshot_digest, fence FROM local_workflow_executions WHERE conversation_id=? AND request_id=?'
      )
      .get(input.conversationId, input.requestId) as
      | { id: string; snapshot_digest: string; fence: number }
      | undefined
    if (previous) {
      if (previous.fence !== input.fence) {
        throw new Error('Existing workflow requires fenced recovery')
      }
      if (previous.snapshot_digest !== digest) {
        throw new Error('Conflicting workflow start request')
      }
      return previous.id
    }
    const active = db
      .prepare(
        "SELECT id FROM local_workflow_executions WHERE conversation_id=? AND state NOT IN ('completed','cancelled','failed') LIMIT 1"
      )
      .get(input.conversationId)
    if (active) {
      throw new Error('This conversation already has an unfinished workflow')
    }
    const id = randomUUID()
    db.prepare(
      `INSERT INTO local_workflow_executions (id, conversation_id, request_id, snapshot_json, snapshot_digest, preset, fence, state, attempt_limit, call_limit, budget_limit) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.requestId,
      json,
      digest,
      input.preset,
      input.fence,
      input.attemptLimit,
      input.callLimit,
      input.budgetLimit
    )
    if (input.owner) {
      const ownerJson = JSON.stringify(input.owner)
      db.prepare(
        'INSERT INTO local_workflow_owners (execution_id,owner_json,owner_digest) VALUES (?,?,?)'
      ).run(id, ownerJson, workflowEvidenceDigest(ownerJson))
    }
    return id
  })
}
