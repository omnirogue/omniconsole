/**
 * Reservation admission: what a reserve request means against the persisted state.
 *
 * Pure over a store snapshot so the compare-and-swap, the idempotency replay, and the
 * location-immutability check can be reasoned about without touching the disk. The store applies
 * the result inside one transaction; nothing here mutates.
 */

import {
  evaluateAgentSessionOperation,
  pruneAgentSessionOperationRows,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  evaluateAgentSessionAcquisition,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  agentSessionExecutionLocationsEqual,
  isAgentSessionLaunchArgs,
  isAgentSessionLaunchEnv,
  type AgentSessionAccountHome,
  type AgentSessionExecutionLocation,
  type AgentSessionLaunchArgs,
  type AgentSessionLaunchEnv,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  agentSessionProviderHandleRoot,
  type AgentSessionHandleProvider,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import {
  reserveAgentSessionOwner,
  type AgentSessionReservation
} from './agent-session-lease-transitions'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { HUB_TASK_ID_PATTERN } from '../../shared/omnios-task-binding'

export type AgentSessionReserveRequest = {
  sessionId: string
  location: AgentSessionExecutionLocation
  provider: AgentSessionHandleProvider
  accountHome: AgentSessionAccountHome
  /** Arguments pinned on first reservation so owner replacement repeats the same launch. */
  launchArgs?: AgentSessionLaunchArgs
  /** Current launch input validated here but never written to the durable record. */
  launchEnv?: AgentSessionLaunchEnv
  /** Provider options requested for the first turn (model, effort); only on a fresh create. */
  options?: Readonly<Record<string, string>>
  hubTaskId?: string
  /** Set only when this create adopts an existing provider conversation. Seeds the handle chain so
   *  the adapter resumes; without it a new record has never proved a thread and starts a fresh one. */
  adoptedHandleLink?: AgentSessionProviderHandleLink
  runtimeKind: AgentSessionReservation['runtimeKind']
  /** Null when the session does not exist yet; otherwise the fence the caller last observed. */
  expectedFence: number | null
  /** A supplier is invoked only when this operation wins a new reservation. */
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  operation: { callerKey: string; operationId: string; fingerprint: string }
  now: number
  leaseTtlMs?: number
}

export type AgentSessionReserveDisposition =
  | 'created'
  | 'reserved'
  | 'retry-reservation'
  | 'replayed'

export type AgentSessionReserveResult = {
  record: AgentSessionRecord
  disposition: AgentSessionReserveDisposition
  operationRow: AgentSessionOperationRow
}

export function evaluateAgentSessionReserveOperation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): AgentSessionOperationDecision {
  state.operations = pruneAgentSessionOperationRows(state.operations, request.now)
  return evaluateAgentSessionOperation({
    rows: state.operations,
    callerKey: request.operation.callerKey,
    operationId: request.operation.operationId,
    fingerprint: request.operation.fingerprint,
    now: request.now
  })
}

export function requireAgentSessionRecordForReplay(
  state: AgentSessionStoreState,
  row: AgentSessionOperationRow,
  sessionId: string
): AgentSessionRecord {
  const replayedId = row.outcome.status === 'succeeded' ? row.outcome.sessionId : sessionId
  const record = state.records.get(replayedId)
  if (!record) {
    // Why: the recorded effect is no longer reconstructable, and re-running it would be a second
    // spawn rather than a replay.
    throw new Error('agent_session_ownership_unknown')
  }
  return record
}

export function admitPendingAgentSessionReservationReplay(
  record: AgentSessionRecord,
  request: AgentSessionReserveRequest
): AgentSessionRecord {
  const decision = evaluateAgentSessionAcquisition({
    lease: record.lease,
    expectedFence: record.lease.runtimeFence,
    handoffOperationId: request.handoffOperationId,
    probe: request.probe
  })
  if (decision.decision === 'refused') {
    throw new Error(decision.code)
  }
  if (decision.decision !== 'retry-reservation') {
    // A replay may continue only its still-present reservation; recovery requires a fresh intent.
    throw new Error('agent_session_ownership_unknown')
  }
  return record
}

export function applyAgentSessionReservation(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest,
  leaseTtlMs: number
): {
  record: AgentSessionRecord
  disposition: Exclude<AgentSessionReserveDisposition, 'replayed'>
} {
  if (request.launchEnv && !isAgentSessionLaunchEnv(request.launchEnv)) {
    throw new Error('agent_session_launch_env_invalid')
  }
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.hubTaskId !== undefined && !HUB_TASK_ID_PATTERN.test(request.hubTaskId)) {
    throw new Error('agent_session_hub_task_invalid')
  }
  if (request.options !== undefined && !isAgentSessionRequestedOptions(request.options)) {
    throw new Error('agent_session_operation_invalid')
  }
  const reservation: AgentSessionReservation = {
    runtimeKind: request.runtimeKind,
    spawnToken:
      typeof request.spawnToken === 'function' ? request.spawnToken() : request.spawnToken,
    claimKeyId: request.claimKeyId,
    handoffOperationId: request.handoffOperationId,
    leaseTtlMs: request.leaseTtlMs ?? leaseTtlMs,
    now: request.now
  }
  // Inside the transaction, not only in the RPC resolver: two concurrent adoptions of one
  // conversation mint different session ids, so the compare-and-swap never collides and a
  // pre-commit check passes for both. Codex would then hold one thread from two app-servers, which
  // it permits silently and which corrupts the conversation rather than erroring.
  assertAdoptedConversationUnowned(state, request)
  const existing = state.records.get(request.sessionId)
  if (!existing) {
    if (state.unreadableRecords.has(request.sessionId)) {
      throw new Error('execution_owner_reconciling')
    }
    if (request.expectedFence !== null) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { record: createAgentSessionRecord(request, reservation), disposition: 'created' }
  }
  if (
    !agentSessionExecutionLocationsEqual(existing.location, request.location) ||
    existing.provider !== request.provider ||
    existing.accountHome.variable !== request.accountHome.variable ||
    existing.accountHome.path !== request.accountHome.path ||
    (request.hubTaskId !== undefined && request.hubTaskId !== existing.hubTaskId)
  ) {
    // Why: location, provider, account, and hub card are session identity; changing one is a fork.
    throw new Error('agent_session_conflict')
  }
  if (request.expectedFence === null) {
    throw new Error('agent_session_conflict')
  }
  const pinned = {
    ...existing,
    ...(!existing.launchArgs && request.launchArgs ? { launchArgs: [...request.launchArgs] } : {}),
    ...(!existing.launchArgs && request.launchArgs ? { updatedAt: request.now } : {})
  }
  return reserveAgentSessionOwner({
    record: pinned,
    expectedFence: request.expectedFence,
    probe: request.probe,
    reservation
  })
}

/**
 * Refuse an adoption whose conversation ANOTHER record already holds.
 *
 * The self-exemption is part of that definition, not a replay mechanism: replay is settled earlier
 * by the operation ledger, and an adoption always arrives with a null expected fence, so a request
 * naming an existing session id is refused a few lines below regardless. Keeping the scan scoped to
 * other records is what makes this guard mean what its name says.
 *
 * It runs inside the store transaction because the pre-commit check in the RPC resolver cannot be
 * the guard: two concurrent adoptions of one conversation mint different session ids, so the
 * compare-and-swap never collides and both would pass. Codex permits two app-servers on one thread
 * silently, so the cost of missing this is a corrupted conversation rather than an error.
 */
function assertAdoptedConversationUnowned(
  state: AgentSessionStoreState,
  request: AgentSessionReserveRequest
): void {
  const adopted = request.adoptedHandleLink
  if (!adopted) {
    return
  }
  const root = agentSessionProviderHandleRoot(adopted.handle)
  for (const record of state.records.values()) {
    if (record.sessionId === request.sessionId) {
      continue
    }
    const holdsSameConversation = record.providerHandleChain.some(
      (link) => agentSessionProviderHandleRoot(link.handle) === root
    )
    if (holdsSameConversation) {
      throw new Error('agent_session_conflict')
    }
  }
}

function createAgentSessionRecord(
  request: AgentSessionReserveRequest,
  reservation: AgentSessionReservation
): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: request.sessionId,
    location: request.location,
    provider: request.provider,
    // Fence 1 below is this record's first, and the owner probe requires the head link to carry the
    // record's current fence — so an adopted link must be minted at that same fence.
    providerHandleChain: request.adoptedHandleLink ? [request.adoptedHandleLink] : [],
    accountHome: request.accountHome,
    ...(request.launchArgs ? { launchArgs: [...request.launchArgs] } : {}),
    // Stricter than upstream's `request.options ? …` on purpose: an empty map is not a
    // request, and recording `options: {}` would make a bare create look like one that
    // pinned a model. `agent-session-record-store-options.test.ts` pins that.
    ...(request.options && Object.keys(request.options).length > 0
      ? { options: { ...request.options } }
      : {}),
    ...(request.hubTaskId ? { hubTaskId: request.hubTaskId } : {}),
    createdAt: request.now,
    updatedAt: request.now,
    lease: {
      sessionId: request.sessionId,
      runtimeKind: reservation.runtimeKind,
      // Why: fence 1 is the first reservation; 0 is reserved for "no owner has ever existed".
      runtimeFence: 1,
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: reservation.spawnToken,
      leaseDeadlineAt: reservation.now + reservation.leaseTtlMs,
      lastRenewedAt: reservation.now,
      handoffOperationId: reservation.handoffOperationId,
      journalCheckpoint: null,
      claimKeyId: reservation.claimKeyId,
      claimStatus: 'reserved',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

const MAX_REQUESTED_OPTIONS = 16
const MAX_REQUESTED_OPTION_LENGTH = 512

/** Bounded string map: the adapter filters keys it knows, so only shape is checked here. */
export function isAgentSessionRequestedOptions(
  value: unknown
): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_REQUESTED_OPTIONS &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 &&
        key.length <= MAX_REQUESTED_OPTION_LENGTH &&
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= MAX_REQUESTED_OPTION_LENGTH
    )
  )
}
