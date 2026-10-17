import { localWorkflowAttemptCost } from './local-workflow-attempt-cost'
import type { WorkflowWebCheck } from '../../../shared/workflow-graph-web'
import type { LocalWorkflowCallView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowCallLive } from '../../../shared/local-workflow-call-live'
import {
  localWorkflowModelLabel,
  localWorkflowProviderLabel
} from '../../../shared/local-workflow-model-label'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { workflowFrozenSeat } from './workflow-program-snapshot'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import { readWorkflowLaunchedAt } from './workflow-launch-receipt'
import { workflowCallSeatId } from './local-workflow-discover-projection'
import { councilSeatModelLabels } from './local-workflow-council-projection'
import {
  graphCallSeatId,
  graphSeatModelLabels,
  isGraphSnapshot
} from './local-workflow-graph-projection'
import type { WorkflowLiveCall, WorkflowLiveExecution } from './workflow-live-registry'
import { localWorkflowReceiptTokens, localWorkflowReportedCostUsd } from './local-workflow-usage'
import { localWorkflowResultMarkdown } from './local-workflow-result-markdown'
import { auditCallSeatId, auditStageId } from './local-workflow-audit-projection'

export type LocalWorkflowCallRecord = {
  call_id: string
  result_json: string | null
  result_digest: string | null
  quarantined: number
}
export type LocalWorkflowAttemptRecord = {
  id: string
  call_id: string
  ordinal: number
  state: string
  receipt_json: string | null
}
/** A verified terminal receipt never changes, so it is read once per attempt, not per view. */
export type LocalWorkflowReceiptSummary = {
  launchedAt?: number
  exitedAt?: number
  error?: string
  /** The provider's own bill, from its result line in the terminal receipt's stdout. */
  costUsd?: number
}
export type LocalWorkflowReceiptCache = Map<string, LocalWorkflowReceiptSummary>

const RECEIPT_CACHE_LIMIT = 4096
const TERMINAL_ATTEMPTS = ['accepted', 'failed', 'cancelled']
const SETTLED_CALLS: LocalWorkflowCallView['state'][] = [
  'completed',
  'failed',
  'cancelled',
  'unverifiable'
]

export function localWorkflowStageId(callId: string): string {
  return callId.startsWith('audit/') ? auditStageId(callId) : callId.split('/')[0]
}

function callSeat(
  snapshot: LocalWorkflowHostSnapshot,
  callId: string,
  live: WorkflowLiveExecution | undefined
): ResolvedLocalWorkflowSeat | undefined {
  const seatId =
    live?.seats.get(callId) ??
    (snapshot.audit
      ? auditCallSeatId(snapshot.audit, callId)
      : isGraphSnapshot(snapshot)
        ? graphCallSeatId(snapshot, callId)
        : callId === 'chair/final'
          ? snapshot.synthesizerId
          : workflowCallSeatId(snapshot, callId))
  return seatId === undefined ? undefined : workflowFrozenSeat(snapshot, seatId)
}

/** `names` numbers a model repeated among Council 6 members, as the run view names them. */
function seatFields(
  seat: ResolvedLocalWorkflowSeat | undefined,
  fallback: string,
  names: ReadonlyMap<string, string>
): Pick<
  LocalWorkflowCallView,
  'seatId' | 'agent' | 'modelLabel' | 'seatLabel' | 'model' | 'effort'
> {
  return {
    ...(seat
      ? {
          seatId: seat.id,
          agent: seat.agent,
          modelLabel: names.get(seat.id) ?? localWorkflowModelLabel(seat.agent, seat.model)
        }
      : {}),
    seatLabel: seat ? localWorkflowProviderLabel(seat.agent) : fallback,
    model: seat?.model ?? '',
    effort: seat?.effort ?? null
  }
}

function liveView(
  call: WorkflowLiveCall,
  state: LocalWorkflowCallView['state']
): LocalWorkflowCallLive {
  // The durable launch outranks a stale "waiting" or "starting" (no spawn signal yet, or none).
  const launched = state === 'running' && (call.phase === 'waiting' || call.phase === 'starting')
  const phase = launched ? 'running' : call.phase
  return {
    phase,
    // The renderer says what a call waits for: "the Codex account" reads differently from a slot.
    ...(phase === 'waiting' && call.reason ? { reason: call.reason } : {}),
    ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}),
    ...(call.activity ? { activity: call.activity } : {}),
    ...(call.tail ? { tail: call.tail } : {}),
    outputChars: call.outputChars,
    ...(call.tokens ? { tokens: { ...call.tokens } } : {})
  }
}

function receiptSummary(
  store: WorkflowCheckpointStore,
  fence: number,
  attempt: LocalWorkflowAttemptRecord,
  cache: LocalWorkflowReceiptCache
): LocalWorkflowReceiptSummary {
  const cached = cache.get(attempt.id)
  if (cached) {
    return cached
  }
  const receipt = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : {}
  let summary: LocalWorkflowReceiptSummary
  if (receipt.noLaunch) {
    summary = typeof receipt.reason === 'string' ? { error: receipt.reason } : {}
  } else if (receipt.interrupted) {
    // Its owner died before the exit was recorded: there is a launch time and no exit.
    let at: number | undefined
    try {
      at = readWorkflowLaunchedAt(store.readProcessIdentity(attempt.id, fence))
    } catch {
      at = undefined
    }
    summary = {
      ...(at !== undefined ? { launchedAt: at } : {}),
      ...(typeof receipt.error === 'string' ? { error: receipt.error } : {})
    }
  } else {
    try {
      const terminal = readWorkflowProcessReceipt(store.readProcessIdentity(attempt.id, fence))
      const costUsd = localWorkflowReportedCostUsd(terminal.result.stdout)
      summary = {
        launchedAt: terminal.launchedAt,
        exitedAt: terminal.exitedAt,
        ...(costUsd !== undefined ? { costUsd } : {})
      }
    } catch (cause) {
      summary = { error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  remember(cache, attempt.id, summary)
  return summary
}

/** A running attempt's launch time never changes either; unreadable evidence is cached as none. */
function launchedAt(
  store: WorkflowCheckpointStore,
  fence: number,
  attempt: LocalWorkflowAttemptRecord,
  cache: LocalWorkflowReceiptCache
): number | undefined {
  const key = `launch:${attempt.id}`
  let summary = cache.get(key)
  if (!summary) {
    let at: number | undefined
    try {
      at = readWorkflowLaunchedAt(store.readProcessIdentity(attempt.id, fence))
    } catch {
      at = undefined
    }
    summary = at === undefined ? {} : { launchedAt: at }
    remember(cache, key, summary)
  }
  return summary.launchedAt
}

function remember(
  cache: LocalWorkflowReceiptCache,
  key: string,
  summary: LocalWorkflowReceiptSummary
): void {
  if (cache.size >= RECEIPT_CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
  cache.set(key, summary)
}

function durableState(
  callId: string,
  results: ReadonlyMap<string, unknown>,
  attempt: LocalWorkflowAttemptRecord | undefined
): LocalWorkflowCallView['state'] {
  if (results.has(callId)) {
    return 'completed'
  }
  if (!attempt) {
    return 'queued'
  }
  if (attempt.state === 'prepared') {
    return 'queued'
  }
  return attempt.state === 'running' || attempt.state === 'failed' || attempt.state === 'cancelled'
    ? attempt.state
    : 'unverifiable'
}

/**
 * Durable calls with a live overlay, then calls that exist only in memory (waiting for a slot).
 * Logs are never read here: pushed views stay small and readCall loads them on demand.
 */
export function projectLocalWorkflowCalls(input: {
  snapshot: LocalWorkflowHostSnapshot
  store: WorkflowCheckpointStore
  fence: number
  attemptLimit: number
  records: readonly LocalWorkflowCallRecord[]
  attempts: readonly LocalWorkflowAttemptRecord[]
  results: ReadonlyMap<string, unknown>
  live?: WorkflowLiveExecution
  receipts: LocalWorkflowReceiptCache
  /** A run that reads pages: the app's checks of an answer's quotes, as data the view draws apart. */
  webNote?: (value: unknown) => WorkflowWebCheck[]
}): { calls: LocalWorkflowCallView[]; latestRecordedExit?: number } {
  const { snapshot, live, webNote } = input
  const names = isGraphSnapshot(snapshot)
    ? graphSeatModelLabels(snapshot)
    : councilSeatModelLabels(snapshot)
  let latestRecordedExit: number | undefined
  const calls = input.records.map((record): LocalWorkflowCallView => {
    const attempt = input.attempts.findLast((entry) => entry.call_id === record.call_id)
    const seat = callSeat(snapshot, record.call_id, live)
    const receipt = attempt?.receipt_json ? JSON.parse(attempt.receipt_json) : undefined
    const summary =
      attempt && TERMINAL_ATTEMPTS.includes(attempt.state)
        ? receiptSummary(input.store, input.fence, attempt, input.receipts)
        : undefined
    if (summary?.exitedAt !== undefined) {
      latestRecordedExit = Math.max(latestRecordedExit ?? 0, summary.exitedAt)
    }
    const liveCall = live?.calls.get(record.call_id)
    const durable = durableState(record.call_id, input.results, attempt)
    // A failed attempt that the durable agent is still retrying is not a failed call yet.
    const state = liveCall && durable === 'failed' ? 'queued' : durable
    const error = receipt?.error ?? summary?.error
    const tokens =
      attempt?.state === 'accepted' && seat
        ? localWorkflowReceiptTokens(seat.agent, receipt?.usage)
        : liveCall?.tokens && { ...liveCall.tokens }
    const cost = seat
      ? localWorkflowAttemptCost(
          input.attempts.filter((entry) => entry.call_id === record.call_id),
          seat,
          (entry) => receiptSummary(input.store, input.fence, entry, input.receipts).costUsd
        )
      : undefined
    const launched =
      attempt?.state === 'running'
        ? launchedAt(input.store, input.fence, attempt, input.receipts)
        : summary?.launchedAt
    // While a call is live its current attempt owns the clock, not an earlier failed attempt.
    const startedAt = liveCall
      ? (liveCall.startedAt ?? (attempt?.state === 'running' ? launched : undefined))
      : launched
    const endedAt = SETTLED_CALLS.includes(state) ? summary?.exitedAt : undefined
    const result = input.results.get(record.call_id)
    const checks = input.results.has(record.call_id) ? webNote?.(result) : undefined
    return {
      id: record.call_id,
      stageId: localWorkflowStageId(record.call_id),
      ...seatFields(seat, record.call_id, names),
      state,
      attempt: attempt?.ordinal ?? 0,
      attemptLimit: input.attemptLimit,
      transport: 'headless',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      ...(typeof error === 'string' && error ? { error } : {}),
      ...(input.results.has(record.call_id)
        ? { resultMarkdown: localWorkflowResultMarkdown(result) }
        : {}),
      ...(checks ? { webChecks: checks } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(tokens ? { tokens } : {}),
      ...(cost ? { cost } : {}),
      ...(liveCall && state !== 'completed' ? { live: liveView(liveCall, state) } : {})
    }
  })
  const durableIds = new Set(input.records.map((record) => record.call_id))
  for (const [callId, liveCall] of live?.calls ?? []) {
    if (durableIds.has(callId)) {
      continue
    }
    calls.push({
      id: callId,
      stageId: localWorkflowStageId(callId),
      ...seatFields(callSeat(snapshot, callId, live), callId, names),
      state: 'queued',
      attempt: 0,
      attemptLimit: input.attemptLimit,
      transport: 'headless',
      stdout: '',
      stderr: '',
      outputTruncated: false,
      live: liveView(liveCall, 'queued')
    })
  }
  return { calls, ...(latestRecordedExit !== undefined ? { latestRecordedExit } : {}) }
}
