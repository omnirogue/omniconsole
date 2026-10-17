import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowCallView, LocalWorkflowView } from '../../../shared/local-workflow-view'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { workflowEvidenceDigest } from './workflow-evidence-digest'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { readLocalWorkflowExecution } from './local-workflow-projection'
import { projectCouncilEvidence, projectCouncilRun } from './local-workflow-council-projection'
import {
  projectDiscoverEvidence,
  projectDiscoverRun,
  workflowCallSeatId
} from './local-workflow-discover-projection'
import type { WorkflowLiveExecution } from './workflow-live-registry'

type WorkingCall = {
  call_id: string
  state: string
  result_json: string | null
  result_digest: string | null
  task_id: string
  dispatch_id: string | null
  task_status: string | null
  release_state: string | null
  terminal_handle: string | null
}

function markdown(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'markdown' in value &&
    typeof value.markdown === 'string'
  ) {
    return value.markdown
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

/** The working view reads only accepted Task/Dispatch evidence, never model claims about execution. */
export function projectWorkingLocalWorkflow(input: {
  db: Database.Database
  store: WorkflowCheckpointStore
  executionId: string
  active: boolean
  error?: string
  /** Program phase and log lines; working calls report no streamed output. */
  live?: WorkflowLiveExecution
}): LocalWorkflowView {
  const row = readLocalWorkflowExecution(input.db, input.executionId)
  const checkpoint = input.store.inspect(row.id, row.fence)
  const snapshot = checkpoint.snapshot as LocalWorkflowHostSnapshot
  if (snapshot.capability?.mode !== 'working-agent') {
    throw new Error('Execution is not a working-agent workflow')
  }
  const run = input.db
    .prepare('SELECT * FROM local_workflow_working_runs WHERE execution_id=?')
    .get(row.id) as
    | { result_json: string | null; result_digest: string | null; finished_at: string | null }
    | undefined
  if (run?.result_json && workflowEvidenceDigest(run.result_json) !== run.result_digest) {
    throw new Error('Working Run result evidence changed')
  }
  const records = input.db
    .prepare(`SELECT c.*,t.status AS task_status,r.release_state,r.terminal_handle
      FROM local_workflow_worker_calls c
      LEFT JOIN tasks t ON t.id=c.task_id
      LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id=c.dispatch_id
      WHERE c.execution_id=? ORDER BY c.rowid`)
    .all(row.id) as WorkingCall[]
  const results = new Map<string, unknown>()
  const calls: LocalWorkflowCallView[] = records.map((record) => {
    if (record.result_json !== null) {
      if (workflowEvidenceDigest(record.result_json) !== record.result_digest) {
        throw new Error(`Working call result evidence changed: ${record.call_id}`)
      }
      if (record.task_status === 'completed' && record.release_state === 'released') {
        results.set(record.call_id, JSON.parse(record.result_json))
      }
    }
    const seatId = workflowCallSeatId(snapshot, record.call_id)
    const seat = snapshot.seats.find((entry) => entry.id === seatId)
    const state: LocalWorkflowCallView['state'] = results.has(record.call_id)
      ? 'completed'
      : record.state === 'unverifiable'
        ? 'unverifiable'
        : record.state === 'failed' || record.task_status === 'failed'
          ? 'failed'
          : record.state === 'prepared'
            ? 'queued'
            : 'running'
    return {
      id: record.call_id,
      stageId: record.call_id.split('/')[0],
      ...(seat
        ? {
            seatId: seat.id,
            agent: seat.agent,
            modelLabel: localWorkflowModelLabel(seat.agent, seat.model)
          }
        : {}),
      seatLabel: seat?.agent === 'codex' ? 'Codex' : seat?.agent === 'grok' ? 'Grok' : 'Claude',
      model: seat?.model ?? '',
      effort: seat?.effort ?? null,
      state,
      attempt: record.dispatch_id ? 1 : 0,
      attemptLimit: 1,
      transport: 'terminal',
      // Details can open the worker's real terminal only while it stays open: before its Dispatch
      // asks to release (close) it, or once it is retained. A release under way never offers it.
      ...(record.terminal_handle &&
      (record.release_state === 'not_requested' || record.release_state === 'retained')
        ? { terminalHandle: record.terminal_handle }
        : {}),
      stdout: '',
      stderr: '',
      outputTruncated: false,
      ...(results.has(record.call_id)
        ? { resultMarkdown: markdown(results.get(record.call_id)) }
        : {})
    }
  })
  const state = (
    row.state === 'recovery_failed' || (input.error && row.state === 'running' && !input.active)
      ? 'recovery_required'
      : row.state
  ) as LocalWorkflowView['state']
  const actions: LocalWorkflowView['actions'] =
    state === 'running' && input.active
      ? ['pause', 'stop']
      : state === 'paused' && !input.active
        ? ['resume', 'stop']
        : state === 'pausing'
          ? ['stop']
          : []
  const discover =
    checkpoint.preset === 'discover'
      ? projectDiscoverEvidence(snapshot, results, state === 'completed')
      : undefined
  const definitions =
    checkpoint.preset === 'council'
      ? [
          {
            id: 'answers',
            label: 'Answers',
            total: 3,
            summary: 'Three independent project answers'
          },
          {
            id: 'peer',
            label: 'Peer review',
            total: 3,
            summary: 'Three blind reviews of candidate artifacts'
          },
          { id: 'synthesis', label: 'Synthesis', total: 1, summary: 'One verified project result' }
        ]
      : [
          {
            id: 'discover',
            label: 'Discover',
            total: snapshot.discover?.dimensions.length ?? 0,
            summary: 'Inspect the project'
          },
          {
            id: 'refute',
            label: 'Refute',
            total: discover?.discoverCounts?.verdictsTotal ?? 0,
            summary: 'Independent skeptical verdicts'
          },
          {
            id: 'rank',
            label: 'Synthesize / Rank',
            total: results.has('rank/final') ? 1 : 0,
            summary: 'Rank surviving findings'
          }
        ]
  const stages = definitions.map((stage) => ({
    ...stage,
    completed: calls.filter((call) => call.stageId === stage.id && call.state === 'completed')
      .length,
    failed: calls.filter((call) => call.stageId === stage.id && call.state === 'failed').length
  }))
  const synthesis = results.get('synthesis/final')
  const synthesizer = snapshot.seats.find((seat) => seat.id === snapshot.synthesizerId)
  const finishedAt = run?.finished_at ? Date.parse(`${run.finished_at}Z`) : undefined
  return {
    executionId: row.id,
    fence: row.fence,
    sequence: row.sequence,
    preset: checkpoint.preset,
    state,
    connection: 'connected',
    prompt: snapshot.task.prompt,
    startedAt: snapshot.host.startedAt,
    ...(finishedAt && Number.isFinite(finishedAt) ? { finishedAt } : {}),
    running: calls.filter((call) => call.state === 'running').length,
    queued: calls.filter((call) => call.state === 'queued').length,
    reused: records.filter((call) => call.state === 'accepted' && call.release_state === 'released')
      .length,
    actions,
    stages,
    calls,
    revision:
      (checkpoint.preset === 'council'
        ? snapshot.councilProgramRevision
        : snapshot.discoverProgramRevision) ?? 1,
    ...(input.live?.phase ? { phase: input.live.phase } : {}),
    ...(input.live?.log.length ? { log: [...input.live.log] } : {}),
    ...(state === 'completed' && synthesizer
      ? {
          followUpSeat: synthesizer,
          followUpLabel: `${synthesizer.agent} · ${synthesizer.model}`
        }
      : {}),
    ...(checkpoint.preset === 'council'
      ? { council: projectCouncilEvidence(snapshot, results) }
      : {}),
    // The run views read these shapes; both map working runs best-effort and never throw.
    ...(checkpoint.preset === 'council'
      ? { councilRun: projectCouncilRun(snapshot, results, calls) }
      : {
          discoverRun: projectDiscoverRun(
            snapshot,
            results,
            calls,
            ['completed', 'cancelled', 'failed', 'recovery_required'].includes(state)
          )
        }),
    ...(synthesis !== undefined && state === 'completed'
      ? {
          result: {
            markdown: markdown(synthesis),
            sources: snapshot.host.sources,
            coverage: snapshot.host.coverage
          }
        }
      : {}),
    ...discover,
    usage: {
      hostAttempts: records.filter((call) => !!call.dispatch_id).length,
      maxHostAttempts: row.budget_limit,
      tokens: null,
      limitation:
        'One writable Dispatch per call; provider-internal tool use is not limited by this count.'
    },
    ...(input.error ? { error: input.error } : {})
  }
}

/** The working view, or a recovery-required view when its evidence cannot be read. */
export function projectWorkingLocalWorkflowOrRecovery(
  input: Parameters<typeof projectWorkingLocalWorkflow>[0]
): LocalWorkflowView {
  try {
    return projectWorkingLocalWorkflow(input)
  } catch (error) {
    const row = readLocalWorkflowExecution(input.db, input.executionId)
    return {
      executionId: input.executionId,
      fence: row.fence,
      sequence: row.sequence,
      preset: row.preset,
      state: 'recovery_required',
      connection: 'connected',
      prompt: 'Working-agent evidence requires recovery.',
      startedAt: 0,
      running: 0,
      queued: 0,
      reused: 0,
      actions: [],
      stages: [],
      calls: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Changes whenever a working call, its Task, its worker resource or the working Run changes. */
export function workingLocalWorkflowDurableKey(db: Database.Database, executionId: string): string {
  const calls = db
    .prepare(
      `SELECT group_concat(c.call_id||':'||c.state||':'||c.result_revision||':'||IFNULL(t.status,'')||':'||IFNULL(r.release_state,''), ',') AS key
      FROM local_workflow_worker_calls c
      LEFT JOIN tasks t ON t.id=c.task_id
      LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id=c.dispatch_id
      WHERE c.execution_id=?`
    )
    .get(executionId) as { key: string | null } | undefined
  const run = db
    .prepare('SELECT state FROM local_workflow_working_runs WHERE execution_id=?')
    .get(executionId) as { state: string } | undefined
  return `${calls?.key ?? ''}|${run?.state ?? ''}`
}
