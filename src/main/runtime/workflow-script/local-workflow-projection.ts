import { localWorkflowRouteNamesModel } from '../../../shared/local-workflow-seats'
import type Database from '../../sqlite/sync-database'
import { LOCAL_WORKFLOW_NOT_FOUND } from '../../../shared/session-workflow-anchor'
import { graphSeatOutcomes } from './local-workflow-graph-seat-outcomes'
import {
  graphHostCallViews,
  graphHostOutcomeRecords,
  graphHostRecords
} from './graph/graph-jev-view'
import { graphWebRules } from './graph/graph-web-types'
import { graphWebViewNote } from './graph/graph-web-citations'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import { workflowEvidenceDigest, type WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  projectUnreadableLocalWorkflow,
  replaysAsEarlierVersion
} from './local-workflow-unreadable-projection'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { localWorkflowPlacementView } from './local-workflow-placement-view'
import type { WorkflowExecutionOutcome } from './workflow-execution-service'
import {
  discoverResultMarkdown,
  discoverStageDefinitions,
  projectDiscoverEvidence
} from './local-workflow-discover-projection'
import { hasWorkflowRetryableCalls } from './workflow-retry-eligibility'
import {
  councilResultMarkdown,
  councilSeatModelLabels,
  councilStageDefinitions,
  projectCouncilEvidence
} from './local-workflow-council-projection'
import {
  projectLocalWorkflowCalls,
  type LocalWorkflowAttemptRecord,
  type LocalWorkflowCallRecord,
  type LocalWorkflowReceiptCache
} from './local-workflow-call-projection'
import type { WorkflowLiveExecution } from './workflow-live-registry'
import { sumLocalWorkflowTokens } from './local-workflow-usage'
import { COUNCIL_REVISION } from './workflow-program-revisions'
import { graphFinishState } from './graph/graph-checkpoint'
import { auditResultMarkdown, auditStageDefinitions } from './local-workflow-audit-projection'
import { projectPresetRun } from './local-workflow-preset-projection'
import {
  graphOutcomesFromRecords,
  isGraphSnapshot,
  projectGraphRun
} from './local-workflow-graph-projection'

type Execution = {
  id: string
  preset: LocalWorkflowView['preset']
  conversation_id: string
  fence: number
  sequence: number
  state: string
  attempt_limit: number
  call_limit: number
  budget_limit: number
  budget_reserved: number
}
export function readLocalWorkflowExecution(db: Database.Database, executionId: string): Execution {
  const row = db.prepare('SELECT * FROM local_workflow_executions WHERE id=?').get(executionId) as
    | Execution
    | undefined
  if (!row) {
    throw new Error(LOCAL_WORKFLOW_NOT_FOUND)
  }
  return row
}

/** Projects durable records plus the in-memory live overlay; logs load through readCall. */
function projectVerifiedLocalWorkflow(input: {
  db: Database.Database
  store: WorkflowCheckpointStore
  executionId: string
  outcome?: WorkflowExecutionOutcome
  active: boolean
  live?: WorkflowLiveExecution
  receipts?: LocalWorkflowReceiptCache
}): LocalWorkflowView {
  const row = readLocalWorkflowExecution(input.db, input.executionId)
  const frozen = input.store.inspect(row.id, row.fence)
  const snapshot = frozen.snapshot as LocalWorkflowHostSnapshot
  const records = input.db
    .prepare('SELECT * FROM local_workflow_calls WHERE execution_id=?')
    .all(row.id) as LocalWorkflowCallRecord[]
  const attempts = input.db
    .prepare('SELECT * FROM local_workflow_attempts WHERE execution_id=? ORDER BY ordinal')
    .all(row.id) as LocalWorkflowAttemptRecord[]
  const results = new Map<string, unknown>()
  for (const call of records) {
    if (call.quarantined) {
      throw new Error(`Workflow result is quarantined: ${call.call_id}`)
    }
    if (call.result_json !== null) {
      if (workflowEvidenceDigest(call.result_json) !== call.result_digest) {
        throw new Error(`Workflow result integrity failure: ${call.call_id}`)
      }
      results.set(call.call_id, JSON.parse(call.result_json))
    }
  }
  const host = isGraphSnapshot(snapshot)
    ? graphHostRecords(row.id, snapshot.graph.spec, graphWebRules(snapshot))
    : {}
  const hostOutcomes = graphHostOutcomeRecords(host, row.id)
  const { calls: agentCalls, latestRecordedExit } = projectLocalWorkflowCalls({
    snapshot,
    store: input.store,
    fence: row.fence,
    attemptLimit: row.attempt_limit,
    records,
    attempts,
    results,
    // The answer as its model wrote it, then the app's own checks of its quotes.
    webNote: graphWebViewNote(snapshot, hostOutcomes),
    live: input.live,
    receipts: input.receipts ?? new Map()
  })
  const calls = [...agentCalls, ...graphHostCallViews(host)]
  const projectedState = input.outcome?.state ?? row.state
  const state = (
    projectedState === 'recovery_failed' ? 'recovery_required' : projectedState
  ) as LocalWorkflowView['state']
  const actions: LocalWorkflowView['actions'] = []
  if (state === 'running' && input.active) {
    actions.push('pause', 'stop')
  }
  if (state === 'paused' && !input.active) {
    actions.push('resume', 'stop')
  }
  if (state === 'pausing') {
    actions.push('stop')
  }
  if (
    state === 'failed' &&
    !input.active &&
    row.budget_reserved < row.budget_limit &&
    hasWorkflowRetryableCalls(input.db, row.id, row.attempt_limit)
  ) {
    actions.push('retry')
  }
  const recordedIds = records.map((record) => record.call_id)
  const { closed, open } = isGraphSnapshot(snapshot)
    ? graphFinishState(snapshot.graph.spec, row.call_limit, recordedIds)
    : { closed: false, open: false }
  const unsettled = !['completed', 'cancelled', 'failed', 'recovery_required'].includes(state)
  // Finish now needs a final step no agent has started: from then on the run is ending anyway.
  const canFinish =
    open && ((state === 'running' && input.active) || (state === 'paused' && !input.active))
  const graph = isGraphSnapshot(snapshot)
    ? projectGraphRun(
        snapshot,
        graphSeatOutcomes({
          snapshot,
          records,
          attempts,
          results,
          outcomes: graphOutcomesFromRecords({
            records,
            attempts,
            results,
            live: input.live,
            active: input.active,
            // The state the view shows, so a call is final whenever the run reads as settled.
            state,
            attemptLimit: row.attempt_limit,
            spec: snapshot.graph.spec,
            ...(hostOutcomes ? { jev: hostOutcomes } : {})
          })
        }),
        input.active,
        closed ? new Set(recordedIds) : undefined
      )
    : undefined
  const discoverEvidence =
    !snapshot.audit && !graph && frozen.preset === 'discover'
      ? projectDiscoverEvidence(snapshot, results, state === 'completed')
      : undefined
  const stageDefinitions = snapshot.audit
    ? auditStageDefinitions(snapshot.audit, results)
    : graph
      ? graph.graphRun.spec.steps.map((step) => ({
          id: step.id,
          label: step.title,
          total: graph.plan.calls.filter((call) => call.stepId === step.id).length
        }))
      : frozen.preset === 'council'
        ? councilStageDefinitions(snapshot, results)
        : discoverStageDefinitions(snapshot, results, discoverEvidence, calls)
  const stages = stageDefinitions.map((stage) => ({
    ...stage,
    completed: calls.filter((call) => call.stageId === stage.id && call.state === 'completed')
      .length,
    failed: calls.filter((call) => call.stageId === stage.id && call.state === 'failed').length
  }))
  const finalMarkdown = snapshot.audit
    ? auditResultMarkdown(results, snapshot.audit.version)
    : graph
      ? graph.plan.outcome?.final?.markdown
      : frozen.preset === 'council'
        ? councilResultMarkdown(snapshot, results)
        : discoverResultMarkdown(snapshot, results)
  const synthesizer = snapshot.seats.find((seat) => seat.id === snapshot.synthesizerId)
  const tokens = sumLocalWorkflowTokens(calls.map((call) => call.tokens))
  // Unpinned runs predate pinning and are always legacy: they report the original revision, 1.
  const revision =
    snapshot.audit?.version ??
    snapshot.graphProgramRevision ??
    (frozen.preset === 'council'
      ? snapshot.councilProgramRevision
      : snapshot.discoverProgramRevision) ??
    1
  return {
    executionId: row.id,
    fence: row.fence,
    sequence: row.sequence,
    preset: frozen.preset,
    state,
    connection: 'connected',
    prompt: snapshot.task.prompt,
    startedAt: snapshot.host.startedAt,
    ...(['completed', 'cancelled', 'failed', 'recovery_required'].includes(state) &&
    latestRecordedExit !== undefined
      ? { finishedAt: Math.max(snapshot.host.startedAt, latestRecordedExit) }
      : {}),
    running: calls.filter((call) => call.state === 'running').length,
    queued: calls.filter((call) => call.state === 'queued').length,
    reused: attempts.filter(
      (attempt) =>
        attempt.state === 'accepted' && JSON.parse(attempt.receipt_json ?? '{}').recoveredByFence
    ).length,
    actions,
    ...(canFinish ? { canFinish: true as const } : {}),
    ...(closed && unsettled ? { finishing: true as const } : {}),
    stages,
    calls,
    revision,
    ...(input.live?.phase ? { phase: input.live.phase } : {}),
    ...(input.live?.log.length ? { log: [...input.live.log] } : {}),
    ...localWorkflowPlacementView(snapshot.host),
    ...(state === 'completed' && synthesizer && !localWorkflowRouteNamesModel(synthesizer.agent)
      ? {
          // The chairman (Council) or ranker (Discover) answers follow-up questions.
          followUpSeat: synthesizer,
          followUpLabel:
            councilSeatModelLabels(snapshot).get(synthesizer.id) ??
            localWorkflowModelLabel(synthesizer.agent, synthesizer.model)
        }
      : {}),
    ...(!graph &&
    frozen.preset === 'council' &&
    (snapshot.councilProgramRevision ?? 4) !== COUNCIL_REVISION
      ? { council: projectCouncilEvidence(snapshot, results) }
      : {}),
    ...(graph
      ? { graphRun: graph.graphRun }
      : projectPresetRun(snapshot, frozen.preset, results, calls, state)),
    ...(finalMarkdown !== undefined && state === 'completed'
      ? {
          result: {
            markdown: finalMarkdown,
            ...(graph?.plan.outcome?.final?.appendix
              ? { appendix: graph.plan.outcome.final.appendix }
              : {}),
            sources: snapshot.host.sources,
            coverage: snapshot.host.coverage
          }
        }
      : {}),
    ...discoverEvidence,
    usage: {
      hostAttempts: row.budget_reserved,
      maxHostAttempts: row.budget_limit,
      tokens: tokens ? { kind: 'reported', ...tokens } : null
    },
    ...(input.outcome?.error ? { error: input.outcome.error } : {})
  }
}

/**
 * A run this build cannot project, or an interrupted one its program no longer replays, keeps
 * its question and offers to start again (local-workflow-unreadable-projection.ts). The verified
 * projection still runs first so its own reason joins the host's in Details.
 */
export function projectLocalWorkflow(
  input: Parameters<typeof projectVerifiedLocalWorkflow>[0]
): LocalWorkflowView {
  let failure: string | undefined
  try {
    const view = projectVerifiedLocalWorkflow(input)
    if (!replaysAsEarlierVersion(input)) {
      return view
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  return projectUnreadableLocalWorkflow({
    db: input.db,
    execution: readLocalWorkflowExecution(input.db, input.executionId),
    active: input.active,
    reasons: [failure, input.outcome?.error]
  })
}
