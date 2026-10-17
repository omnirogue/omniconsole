// `run-show --queue`: joins the Run's unfinished Tasks to what each worker's session shows right
// now. Read-only by construction: no lifecycle is reconciled, nothing is stopped, retried or
// released, and a session that cannot be read is reported as such instead of guessed at.

import { classifyAgentTurnFailure } from '../../../../shared/agent-turn-failure'
import {
  deriveRunQueueAttention,
  type RunQueueRow,
  type RunQueueSession,
  type RunQueueSessionStatus,
  type RunQueueSummary
} from '../../../../shared/orchestration-run-queue'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { readRunQueue, type RunQueueTaskRow } from '../../orchestration/db/runs/run-queue-read'
import { inspectWorkerTerminal } from './orchestration-worker-observation'

/** One slow or unreachable worker server must not hold the whole summary. */
const REMOTE_OBSERVATION_TIMEOUT_MS = 8_000

const SESSION_STATUSES: readonly RunQueueSessionStatus[] = [
  'live',
  'unverifiable',
  'exited',
  'missing',
  'identity_changed',
  'unattached'
]

const REMOTE_TEXT_MAX = 200

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, REMOTE_TEXT_MAX) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * What another server said about its worker, kept to the fields this view prints. Why re-read
 * field by field: the reply crosses a version boundary, so its shape is evidence, never a type.
 */
function readRemoteSession(server: string, reply: unknown): RunQueueSession {
  const observation = asRecord(asRecord(reply)?.observation)
  const reported = observation?.status === 'running' ? 'live' : observation?.status
  const status = SESSION_STATUSES.find((known) => known === reported)
  if (!status) {
    return {
      status: 'unverifiable',
      reason: `${server} reported no session status this build understands`
    }
  }
  const session: RunQueueSession = { status }
  const reason = boundedText(observation?.reason)
  if (reason) {
    session.reason = reason
  }
  if (observation && 'agentWait' in observation) {
    const wait = asRecord(observation.agentWait)
    const waitReason = boundedText(wait?.reason)
    // Why: a present null means "looked, nothing waiting"; an unreadable value stays absent.
    if (observation.agentWait === null) {
      session.agentWait = null
    } else if (wait) {
      session.agentWait = {
        source: boundedText(wait.source) ?? 'unknown',
        ...(waitReason ? { reason: waitReason } : {})
      }
    }
  }
  const lastOutputAt = asRecord(asRecord(reply)?.terminal)?.lastOutputAt
  if (
    lastOutputAt === null ||
    (typeof lastOutputAt === 'number' && Number.isFinite(lastOutputAt))
  ) {
    session.lastOutputAt = lastOutputAt
  }
  return session
}

function terminalHandle(row: RunQueueTaskRow): string | null {
  return row.agent_terminal_handle ?? row.assignee_handle
}

/** A released terminal is gone by design; looking for it would only report a false `missing`. */
function hasSessionToObserve(row: RunQueueTaskRow): boolean {
  return (
    row.dispatch_id !== null &&
    row.dispatch_status !== 'completed' &&
    row.terminal_release_state !== 'released' &&
    (row.server !== null || terminalHandle(row) !== null)
  )
}

async function observeLocalSession(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  row: RunQueueTaskRow
): Promise<RunQueueSession> {
  const observed = await inspectWorkerTerminal(runtime, db, row.dispatch_id!)
  const session: RunQueueSession = {
    status: observed.status,
    ...(observed.reason ? { reason: observed.reason } : {}),
    // Why conditional: absent means "not evaluated"; a `?? null` here would claim "not waiting".
    ...(observed.agentWait !== undefined ? { agentWait: observed.agentWait } : {})
  }
  if (!observed.exact || !observed.terminal) {
    return session
  }
  session.lastOutputAt = observed.terminal.lastOutputAt
  const handle = terminalHandle(row)
  const hook = handle ? runtime.getFreshAgentHookStatusForHandle(handle) : null
  if (hook) {
    session.agentState = hook.state
    session.providerLimited =
      hook.state === 'done' &&
      hook.failed === true &&
      classifyAgentTurnFailure(hook.failureReason) === 'usage-limit'
  }
  return session
}

async function observeRemoteSession(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  row: RunQueueTaskRow
): Promise<RunQueueSession> {
  const federated = db.getFederatedDispatch(row.dispatch_id!)
  if (!federated) {
    return { status: 'unattached' }
  }
  try {
    // Why federationShow directly: workerShow would also reconcile this Dispatch's lifecycle.
    const reply = await runtime.callOrchestrationWorkerServer(
      federated.environment_id,
      'orchestration.federationShow',
      { dispatchId: federated.dispatch_id },
      REMOTE_OBSERVATION_TIMEOUT_MS
    )
    return readRemoteSession(federated.environment_name, reply)
  } catch (error) {
    // Why: a server that did not answer was not observed. That is never `exited`.
    return {
      status: 'unverifiable',
      reason: `${federated.environment_name} did not answer: ${boundedText(error instanceof Error ? error.message : String(error)) ?? 'no reason given'}`
    }
  }
}

function latestMs(values: (string | number | null | undefined)[]): number | null {
  const times = values
    .map((value) => (typeof value === 'string' ? Date.parse(value) : value))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return times.length > 0 ? Math.max(...times) : null
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export async function buildRunQueue(
  runtime: OrcaRuntimeService,
  params: { runId: string; limit: number },
  nowMs = Date.now()
): Promise<RunQueueSummary> {
  const db = runtime.getOrchestrationDb()
  const read = readRunQueue(db, params)
  const rows = await Promise.all(
    read.rows.map(async (row): Promise<RunQueueRow> => {
      const session = hasSessionToObserve(row)
        ? await (
            row.server
              ? observeRemoteSession(runtime, db, row)
              : observeLocalSession(runtime, db, row)
          ).catch((): RunQueueSession => ({
            status: 'unverifiable',
            reason: 'the session could not be read'
          }))
        : null
      const derived = deriveRunQueueAttention({
        taskStatus: row.task_status,
        dispatchStatus: row.dispatch_status,
        workerState: row.worker_state,
        stage: row.worker_stage,
        session,
        openQuestions: row.open_questions,
        lastActivityAtMs: latestMs([
          row.last_heartbeat_at,
          row.worker_updated_at,
          session?.lastOutputAt
        ]),
        nowMs
      })
      return {
        taskId: row.task_id,
        title: oneLine(row.display_name ?? row.task_title ?? row.spec, 120),
        taskStatus: row.task_status,
        attempts: row.attempts,
        dispatch: row.dispatch_id
          ? {
              id: row.dispatch_id,
              status: row.dispatch_status ?? 'unknown',
              workerState: row.worker_state ?? 'unsupervised',
              stage: row.worker_stage ?? 'unknown',
              lastError: row.worker_error ?? row.last_failure,
              dispatchedAt: row.dispatched_at,
              lastHeartbeatAt: row.last_heartbeat_at,
              updatedAt: row.worker_updated_at,
              terminalHandle: terminalHandle(row),
              server: row.server
            }
          : null,
        session,
        openQuestions: row.open_questions,
        ...derived
      }
    })
  )
  return {
    runId: params.runId,
    generatedAt: new Date(nowMs).toISOString(),
    taskCounts: read.taskCounts,
    omitted: Math.max(0, read.unfinished - rows.length),
    limit: params.limit,
    rows
  }
}
