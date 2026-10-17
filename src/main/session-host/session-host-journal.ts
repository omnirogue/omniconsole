/**
 * The durable record an execution account keeps for Phase 4 session host control: which
 * conversations this host owns, every operation it admitted (or refused), the reservations holding
 * conversations, relocation grants and the live host processes. One file per execution account,
 * shared by every runtime profile and relay version on it (docs/reference/session-host-control.md).
 *
 * Records are kept as parsed objects and updated by spreading, so a field a newer build added
 * inside version 1 survives an older build's rewrite. A structural change bumps `v`; an older build
 * then reads what it can and refuses to write.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import {
  isSessionHostId,
  type SessionHostConversationRecord,
  type SessionHostOwnershipGrant,
  type SessionHostRelinquishment,
  type SessionHostReservation
} from '../../shared/session-host-identity'
import type {
  SessionHostAction,
  SessionHostOperationRecord
} from '../../shared/session-host-protocol'

export const SESSION_HOST_JOURNAL_VERSION = 1

/** `local-write`: an automatic writer on this host admitted at the conversation send door. */
export type SessionHostOperationKind = 'execute' | 'reserve' | 'release' | 'local-write'

export type SessionHostOperationAudit = {
  authority: SessionHostAuthority['kind'] | 'local-writer'
  peer?: string
  computer?: string
  requester?: string
  /** The person's words; audited, never approval. */
  request?: string
  reason?: string
  /** Why an unconfirmed operation's delivery is unknowable. */
  detail?: string
}

export type SessionHostJournalOperation = SessionHostOperationRecord & {
  kind: SessionHostOperationKind
  /** The peer or local writer that took it; only it may run under or release its reservation. */
  holder: string
  /** The host process that admitted it; only that process dispatches it. */
  controller: string
  /** The reservation it ran under, when the request named one. */
  runsUnder?: string
  audit: SessionHostOperationAudit
}

export type SessionHostJournalReservation = SessionHostReservation & {
  action: SessionHostAction
  /** `sessionHostTurnReservationKey`; null when the action fences no turn. */
  key: string | null
  /** The operation dispatching under it right now. */
  running?: string
}

export type SessionHostWorkspace = { kind: 'git' | 'folder'; path: string }

/** A host inventory registration: the authoritative record plus what this host needs to run it. */
export type SessionHostRegistration = SessionHostConversationRecord & {
  /** False until ownership was verified; control is refused until then. */
  adopted: boolean
  /** False once relinquished to another host; nothing here runs it again at that epoch. */
  owned: boolean
  /** The incarnation of the host process that executes it (a runtime profile or relay daemon). */
  controller: string | null
  /** How this host's own panes address it; a presentation key, never execution evidence. */
  binding: ConversationSource | null
  workspace: SessionHostWorkspace | null
  registeredAt: number
  adoptedAt?: number
  relinquishment?: SessionHostRelinquishment
}

export type SessionHostJournalGrant = {
  grant: SessionHostOwnershipGrant
  /** `issued` by the source at relinquishment; `consumed` by the destination, exactly once. */
  role: 'issued' | 'consumed'
  at: number
  /** The operation that consumed it; no other operation may use it. */
  consumer?: string
}

export type SessionHostControllerKind = 'paired-runtime' | 'ssh-relay'

/** A host process that may be mid-dispatch. Present until it is confirmed gone. */
export type SessionHostController = {
  incarnation: string
  kind: SessionHostControllerKind
  pid: number
  /** Process start identity (pid reuse guard); null when the platform could not read it. */
  processIdentity: string | null
  startedAt: number
}

export type SessionHostJournal = {
  v: typeof SESSION_HOST_JOURNAL_VERSION
  hostId: string
  /** Op ids stamped at or before this were evicted, so they are never admitted again. */
  horizon: number
  operations: Record<string, SessionHostJournalOperation>
  reservations: Record<string, SessionHostJournalReservation>
  conversations: Record<string, SessionHostRegistration>
  grants: Record<string, SessionHostJournalGrant>
  controllers: Record<string, SessionHostController>
}

export function emptySessionHostJournal(hostId: string): SessionHostJournal {
  return {
    v: SESSION_HOST_JOURNAL_VERSION,
    hostId,
    horizon: 0,
    operations: {},
    reservations: {},
    conversations: {},
    grants: {},
    controllers: {}
  }
}

export type SessionHostJournalRead =
  | { ok: true; journal: SessionHostJournal; writable: true }
  /** A newer build's journal: readable for lookups, never rewritten by this one. */
  | { ok: true; journal: SessionHostJournal; writable: false }
  | { ok: false; detail: string }

const MAPS = [
  'operations',
  'reservations',
  'conversations',
  'grants',
  'controllers'
] as const satisfies readonly (keyof SessionHostJournal)[]

function isRecordMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    )
  )
}

/** Never guesses: an unreadable journal refuses mutation and is left exactly as found. */
export function parseSessionHostJournal(text: string, hostId: string): SessionHostJournalRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'the session host journal is not valid JSON' }
  }
  const record = parsed as Partial<Record<keyof SessionHostJournal, unknown>> | null
  if (!record || typeof record !== 'object' || typeof record.v !== 'number') {
    return { ok: false, detail: 'the session host journal has no version' }
  }
  if (record.hostId !== hostId || !isSessionHostId(record.hostId)) {
    return { ok: false, detail: 'the session host journal belongs to another host id' }
  }
  if (typeof record.horizon !== 'number' || !MAPS.every((key) => isRecordMap(record[key]))) {
    return { ok: false, detail: 'the session host journal is incomplete' }
  }
  const journal = parsed as SessionHostJournal
  return record.v === SESSION_HOST_JOURNAL_VERSION
    ? { ok: true, journal, writable: true }
    : record.v > SESSION_HOST_JOURNAL_VERSION
      ? { ok: true, journal, writable: false }
      : { ok: false, detail: `the session host journal version ${record.v} is unknown` }
}

/** The wire record: internal bookkeeping (holder, controller, audit) never leaves the host. */
export function sessionHostWireOperation(
  operation: SessionHostJournalOperation
): SessionHostOperationRecord {
  const {
    kind: _kind,
    holder: _holder,
    controller: _controller,
    runsUnder: _runsUnder,
    audit: _audit,
    ...wire
  } = operation
  return wire
}
