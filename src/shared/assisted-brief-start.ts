import { deriveBriefStartIdentity } from './assisted-brief-hash'
import { currentBriefRevision } from './assisted-brief-revisions'
import {
  ASSISTED_BRIEF_LIMITS,
  type AssistedBriefRecord,
  type BriefStartFailure,
  type BriefStartRecord
} from './assisted-brief-types'

/** The start requested for the current revision, if any. */
export function currentRevisionStart(record: AssistedBriefRecord): BriefStartRecord | null {
  const current = currentBriefRevision(record)
  const { operationId } = deriveBriefStartIdentity(
    record.briefId,
    current.number,
    current.contentHash
  )
  return record.starts.find((start) => start.operationId === operationId) ?? null
}

/** Whether a tab with this id exists; 'unknown' while tabs are still being restored. */
export type BriefTabProbe = (tabId: string) => 'present' | 'absent' | 'unknown'

export type BriefStartPlan =
  | { kind: 'launch'; record: AssistedBriefRecord; start: BriefStartRecord }
  | { kind: 'already-running'; record: AssistedBriefRecord; start: BriefStartRecord }
  | {
      kind: 'refused'
      reason:
        | 'workspace-changed'
        | 'in-flight'
        | 'already-started'
        | 'needs-confirmation'
        | 'sessions-restoring'
    }

function upsertStart(
  record: AssistedBriefRecord,
  start: BriefStartRecord,
  now: number
): AssistedBriefRecord {
  const others = record.starts.filter((entry) => entry.operationId !== start.operationId)
  return {
    ...record,
    starts: [...others, start].slice(-ASSISTED_BRIEF_LIMITS.startsKept),
    updatedAt: now
  }
}

/**
 * Start approves the current revision and records the start before anything launches.
 * One start per approved revision: a second click, a retry or a restart derives the same
 * operation, and a tab already carrying its id means the work launched, so it never relaunches.
 */
export function planBriefStart(
  record: AssistedBriefRecord,
  input: {
    workspaceKey: string
    favoriteId: string
    verifiable: boolean
    now: number
    probe: BriefTabProbe
  }
): BriefStartPlan {
  // Why: callers rebind first (readCurrentBrief); a record bound elsewhere is never approved here.
  if (record.workspaceKey !== input.workspaceKey) {
    return { kind: 'refused', reason: 'workspace-changed' }
  }
  const current = currentBriefRevision(record)
  const identity = deriveBriefStartIdentity(record.briefId, current.number, current.contentHash)
  const existing = record.starts.find((start) => start.operationId === identity.operationId)
  if (existing?.status === 'starting') {
    return { kind: 'refused', reason: 'in-flight' }
  }
  if (existing?.status === 'started') {
    return { kind: 'refused', reason: 'already-started' }
  }
  if (existing?.status === 'unconfirmed') {
    return { kind: 'refused', reason: 'needs-confirmation' }
  }
  // Why: before saved tabs are restored, a launch could reuse the id of a tab that is about to come back.
  const seen = input.verifiable ? input.probe(identity.tabId) : 'absent'
  if (seen === 'unknown') {
    return { kind: 'refused', reason: 'sessions-restoring' }
  }
  const approved: AssistedBriefRecord = {
    ...record,
    approval: {
      revision: current.number,
      contentHash: current.contentHash,
      workspaceKey: input.workspaceKey,
      approvedAt: input.now
    }
  }
  const start: BriefStartRecord = {
    ...identity,
    launchedTabId: null,
    revision: current.number,
    contentHash: current.contentHash,
    workspaceKey: input.workspaceKey,
    favoriteId: input.favoriteId,
    status: 'starting',
    verifiable: input.verifiable,
    requestedAt: input.now
  }
  if (seen === 'present') {
    const found: BriefStartRecord = {
      ...start,
      status: 'started',
      launchedTabId: identity.tabId,
      settledAt: input.now
    }
    return {
      kind: 'already-running',
      record: upsertStart(approved, found, input.now),
      start: found
    }
  }
  return { kind: 'launch', record: upsertStart(approved, start, input.now), start }
}

export type BriefLaunchOutcome =
  | { ok: true; tabId: string | null }
  | { ok: false; failure: Exclude<BriefStartFailure, 'released'> }

/** Records a definite launch result. Only the in-flight start of that operation changes. */
export function settleBriefStart(
  record: AssistedBriefRecord,
  operationId: string,
  outcome: BriefLaunchOutcome,
  now: number
): AssistedBriefRecord {
  const start = record.starts.find((entry) => entry.operationId === operationId)
  if (!start || start.status !== 'starting') {
    return record
  }
  const settled: BriefStartRecord = outcome.ok
    ? {
        ...start,
        status: 'started',
        launchedTabId: outcome.tabId,
        verifiable: start.verifiable && outcome.tabId !== null,
        settledAt: now
      }
    : { ...start, status: 'not-started', failure: outcome.failure, settledAt: now }
  return upsertStart(record, settled, now)
}

/**
 * After a restart or an uncertain launch, look for the session instead of replaying the start.
 * A found tab settles it; otherwise the person decides, because a missing tab may have been
 * closed after the work began.
 */
export function reconcileBriefStarts(
  record: AssistedBriefRecord,
  probe: BriefTabProbe,
  now: number
): AssistedBriefRecord {
  let next = record
  for (const start of record.starts) {
    if (start.status !== 'starting' && start.status !== 'unconfirmed') {
      continue
    }
    const seen = start.verifiable ? probe(start.tabId) : 'unknown'
    if (seen === 'present') {
      next = upsertStart(
        next,
        { ...start, status: 'started', launchedTabId: start.tabId, settledAt: now },
        now
      )
    } else if (start.status === 'starting' && (seen === 'absent' || !start.verifiable)) {
      next = upsertStart(next, { ...start, status: 'unconfirmed', settledAt: now }, now)
    }
  }
  return next
}

/** The person checked and the work did not start; Start may run the same operation again. */
export function releaseUnconfirmedStart(
  record: AssistedBriefRecord,
  operationId: string,
  now: number
): AssistedBriefRecord {
  const start = record.starts.find((entry) => entry.operationId === operationId)
  if (!start || start.status !== 'unconfirmed') {
    return record
  }
  return upsertStart(
    record,
    { ...start, status: 'not-started', failure: 'released', settledAt: now },
    now
  )
}
