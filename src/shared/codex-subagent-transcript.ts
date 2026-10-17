import { extname, isAbsolute } from 'node:path'
import {
  readJsonlCursor,
  resolveChildTranscript,
  type JsonlCursor
} from './codex-subagent-transcript-io'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import {
  finishCodexSubagent,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'
const CHILD_UNREADABLE_GRACE_MS = 60_000
const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

type TrackedTranscriptSubagent = JsonlCursor & {
  description?: string
  /** Latest model seen in the child's own rollout. Retained across polls
   *  because the cursor is incremental: `turn_context` is emitted once per
   *  turn, so a later read usually carries no model at all. */
  model?: string
  startedAt: number
  unresolvedSince?: number
  completionSeen?: boolean
}

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  backlogProgress?: boolean
  interruptScan?: JsonlCursor
  subagents: Map<string, TrackedTranscriptSubagent>
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

function readActivity(recordValue: JsonRecord):
  | {
      id: string
      description?: string
      kind: 'started' | 'interacted' | 'interrupted'
      startedAt: number
    }
  | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  if (payload?.type !== 'sub_agent_activity') {
    return undefined
  }
  const id = typeof payload.agent_thread_id === 'string' ? payload.agent_thread_id.trim() : ''
  const rawKind = typeof payload.kind === 'string' ? payload.kind.toLowerCase() : ''
  if (
    !SAFE_THREAD_ID.test(id) ||
    (rawKind !== 'started' && rawKind !== 'interacted' && rawKind !== 'interrupted')
  ) {
    return undefined
  }
  return {
    id,
    description:
      typeof payload.agent_path === 'string' ? payload.agent_path.trim() || undefined : undefined,
    kind: rawKind,
    startedAt:
      typeof payload.occurred_at_ms === 'number' && Number.isFinite(payload.occurred_at_ms)
        ? payload.occurred_at_ms
        : Date.now()
  }
}

/** Latest model from the child's own `turn_context` records. A child can be
 *  launched on a different model than its parent, so this is read from the
 *  child rollout rather than inherited. */
function readChildModel(records: JsonRecord[]): string | undefined {
  let model: string | undefined
  for (const recordValue of records) {
    if (recordValue.type !== 'turn_context') {
      continue
    }
    const payload = record(recordValue.payload)
    const value = typeof payload?.model === 'string' ? payload.model.trim() : ''
    if (value) {
      model = value
    }
  }
  return model
}

function childIsComplete(records: JsonRecord[], complete = false): boolean {
  for (const recordValue of records) {
    if (recordValue.type !== 'event_msg') {
      continue
    }
    const payload = record(recordValue.payload)
    if (payload?.type === 'task_started') {
      complete = false
    } else if (payload?.type === 'task_complete') {
      complete = true
    }
  }
  return complete
}

export function createCodexSubagentTranscriptState(): CodexSubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    subagents: new Map()
  }
}

/** Backlog polls run promptly while preserving bounded sequential discovery. */
export function codexTranscriptPollDelay(
  state: CodexSubagentTranscriptState | undefined
): number | undefined {
  return state?.backlogProgress &&
    ((state.parent.remainingBytes ?? 0) > 0 || state.parent.pendingRecords?.length)
    ? 10
    : undefined
}

export function hasTrackedCodexTranscriptSubagents(
  state: CodexSubagentTranscriptState | undefined
): boolean {
  return Boolean(
    state &&
    (state.subagents.size > 0 ||
      (state.parent.remainingBytes ?? 0) > 0 ||
      state.parent.pendingRecords?.length)
  )
}

async function reconcileTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined,
  isCurrent: () => boolean = () => true
): Promise<void> {
  state.backlogProgress = false
  if (!isCurrent()) {
    return
  }
  const normalizedPath = transcriptPath?.trim()
  if (!normalizedPath || !isAbsolute(normalizedPath) || extname(normalizedPath) !== '.jsonl') {
    return
  }
  if (state.parent.filePath !== normalizedPath) {
    for (const id of state.subagents.keys()) {
      finishCodexSubagent(roster, id)
    }
    state.parent = { filePath: normalizedPath, offset: 0, carry: '' }
    state.subagents.clear()
    state.interruptScan = undefined
  }
  const parent = state.parent
  const budget = { remaining: 1024 * 1024 }
  const parentOffset = parent.offset
  const parentRecords = await readJsonlCursor(parent, budget)
  if (state.parent !== parent || !isCurrent()) {
    parent.pendingRecords = parentRecords
    return
  }
  if (!parentRecords) {
    parent.remainingBytes = 0
  }
  state.backlogProgress = parent.offset > parentOffset
  const recordsToApply = parentRecords ?? []
  const deferred = new Map<string, JsonRecord>()
  for (let index = 0; index < recordsToApply.length; index++) {
    const recordValue = recordsToApply[index]
    const activity = readActivity(recordValue)
    if (!activity) {
      continue
    }
    if (activity.kind === 'interrupted') {
      deferred.delete(activity.id)
      finishCodexSubagent(roster, activity.id)
      state.subagents.delete(activity.id)
      continue
    }
    if (!state.subagents.has(activity.id) && state.subagents.size >= AGENT_STATUS_MAX_SUBAGENTS) {
      // Keep discovery records until catch-up retires historical children.
      deferred.set(activity.id, recordValue)
      continue
    }
    deferred.delete(activity.id)
    const tracked = state.subagents.get(activity.id) ?? {
      offset: 0,
      carry: '',
      startedAt: activity.startedAt
    }
    tracked.description = activity.description ?? tracked.description
    state.subagents.set(activity.id, tracked)
    upsertCodexSubagent(
      roster,
      activity.id,
      { description: tracked.description, state: 'working' },
      tracked.startedAt
    )
  }
  parent.pendingRecords = deferred.size > 0 ? Array.from(deferred.values()) : undefined
  if (deferred.size > 0) {
    // While discovery waits for a slot, scan ahead for interrupts that can
    // release one. The primary cursor still owns every future start record.
    const scan = (state.interruptScan ??= {
      filePath: normalizedPath,
      offset: parent.lineStartOffset ?? 0,
      carry: ''
    })
    const scanOffset = scan.offset
    const interrupts = await readJsonlCursor(scan, budget)
    if (state.parent !== parent || !isCurrent()) {
      scan.pendingRecords = interrupts
      return
    }
    state.backlogProgress ||= scan.offset > scanOffset
    for (const recordValue of interrupts ?? []) {
      const activity = readActivity(recordValue)
      if (activity?.kind !== 'interrupted') {
        continue
      }
      deferred.delete(activity.id)
      finishCodexSubagent(roster, activity.id)
      state.subagents.delete(activity.id)
    }
    parent.pendingRecords = deferred.size > 0 ? Array.from(deferred.values()) : undefined
    if (deferred.size === 0) {
      state.interruptScan = undefined
    }
  } else {
    state.interruptScan = undefined
  }
  const entriesByDirectory = new Map<string, string[]>()
  const now = Date.now()
  const children = Array.from(state.subagents)
  for (const [id, tracked] of children) {
    if (budget.remaining === 0 || state.parent !== parent || !isCurrent()) {
      break
    }
    if (!tracked.filePath) {
      tracked.filePath = await resolveChildTranscript(
        normalizedPath,
        id,
        tracked.startedAt,
        entriesByDirectory
      )
    }
    const childOffset = tracked.offset
    const records = await readJsonlCursor(tracked, budget)
    if (state.parent !== parent || !isCurrent()) {
      tracked.pendingRecords = records
      return
    }
    state.backlogProgress ||= tracked.offset > childOffset
    state.subagents.delete(id)
    state.subagents.set(id, tracked)
    if (!records) {
      // Why: a rollout that never appears (or is deleted) has no completion event, so time-box it instead of leaking a working row.
      tracked.filePath = undefined
      tracked.unresolvedSince ??= now
      if (now - tracked.unresolvedSince <= CHILD_UNREADABLE_GRACE_MS) {
        continue
      }
    } else {
      tracked.unresolvedSince = undefined
      tracked.model = readChildModel(records) ?? tracked.model
      // Why: re-applied every reconcile, not just on discovery — the parent's
      // own activity upsert can rebuild this child's roster entry, which would
      // otherwise drop a model found on an earlier poll.
      setCodexSubagentModel(roster, id, tracked.model)
      tracked.completionSeen = childIsComplete(records, tracked.completionSeen)
      if (!tracked.completionSeen || (tracked.remainingBytes ?? 0) > 0 || tracked.carry) {
        continue
      }
    }
    finishCodexSubagent(roster, id)
    state.subagents.delete(id)
  }
}

const reconciliations = new WeakMap<CodexSubagentTranscriptState, Promise<void>>()
export function reconcileCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const pending = reconciliations.get(state)
  if (pending) {
    return state.parent.filePath === transcriptPath?.trim()
      ? pending
      : pending.then(() =>
          reconcileCodexSubagentTranscript(state, roster, transcriptPath, isCurrent)
        )
  }
  const operation = reconcileTranscript(state, roster, transcriptPath, isCurrent).finally(() =>
    reconciliations.delete(state)
  )
  reconciliations.set(state, operation)
  return operation
}
