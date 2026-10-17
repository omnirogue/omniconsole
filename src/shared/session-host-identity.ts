/**
 * Identity for Phase 4 session host control: which execution host owns a conversation, under which
 * owner epoch, and which turn an operation consumes. docs/reference/session-host-control.md.
 */

import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'
import { sha256 } from './sha256'

const HEX32 = /^[0-9a-f]{32}$/
const CONVERSATION_ID = /^conv_[0-9a-f]{32}$/
const HOST_ID = /^host_[0-9a-f]{32}$/
const INCARNATION = /^[A-Za-z0-9_.:-]{1,128}$/
// Why printable-only: revisions are echoed into audit lines and refusal messages.
const OPAQUE_REVISION = /^[\x21-\x7e]{1,256}$/
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

export const SESSION_HOST_MAX_OWNER_EPOCH = Number.MAX_SAFE_INTEGER

function hex32(uuid: string): string {
  const entropy = uuid.replaceAll('-', '').toLowerCase()
  if (!HEX32.test(entropy)) {
    throw new Error('A session host identity needs a UUID or 32 hex digits')
  }
  return entropy
}

/** Opaque and host-minted; independent of workspace path, a Mac's aliases and credentials. */
export function sessionHostConversationId(uuid: string): string {
  return `conv_${hex32(uuid)}`
}

export function isSessionHostConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
}

/** One per execution account (machine + OS user), persisted in its ownership registry. */
export function sessionHostId(uuid: string): string {
  return `host_${hex32(uuid)}`
}

export function isSessionHostId(value: unknown): value is string {
  return typeof value === 'string' && HOST_ID.test(value)
}

/** One per host process start (a relay daemon or runtime); a change forces renegotiation. */
export function isSessionHostIncarnation(value: unknown): value is string {
  return typeof value === 'string' && INCARNATION.test(value)
}

/** The `<13-digit ms>-<32 hex>` form `conversationDeliveryOperationId` mints. */
export function isSessionHostOperationId(value: unknown): value is string {
  return typeof value === 'string' && parseAgentSessionOperationTimestamp(value) !== null
}

export function isSessionHostOwnerEpoch(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= SESSION_HOST_MAX_OWNER_EPOCH
  )
}

/** Turn and organization revisions are host-minted; clients only echo what observe returned. */
export function isSessionHostRevision(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_REVISION.test(value)
}

export function isSessionHostDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value)
}

/** `sha256:<64 hex>` of UTF-8 text: the one digest spelling every session host record uses. */
export function sessionHostDigest(text: string): string {
  const bytes = sha256(new TextEncoder().encode(text))
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The answering host and its process start; a negotiation is bound to both. */
export type SessionHostIdentity = { hostId: string; incarnation: string }

/** Provider-native identity (`claude` + its session id); relocation must preserve it exactly. */
export type SessionHostProviderIdentity = { agent: string; sessionId: string }

/** The authoritative record, held only by the executing host. */
export type SessionHostConversationRecord = {
  conversationId: string
  hostId: string
  /** Starts at 1; only a relocation's consumed grant advances it. */
  ownerEpoch: number
  provider: SessionHostProviderIdentity
  /** Null while no provider process runs for it. */
  processIncarnation: string | null
}

/**
 * `held`: intent durable, nothing sent. `dispatched`: bytes may have moved. `unconfirmed`: a crash
 * or lost reply left delivery unknowable; it keeps blocking until reconciled, never resent.
 */
export const SESSION_HOST_RESERVATION_STATES = [
  'held',
  'dispatched',
  'settled',
  'released',
  'unconfirmed'
] as const
export type SessionHostReservationState = (typeof SESSION_HOST_RESERVATION_STATES)[number]

export function sessionHostReservationBlocks(state: SessionHostReservationState): boolean {
  return state === 'held' || state === 'dispatched' || state === 'unconfirmed'
}

/**
 * Admission reserves the operation id AND the conversation's turn atomically: two Macs that mint
 * different ids for one idle turn contend for this one key.
 */
export type SessionHostReservation = {
  operationId: string
  conversationId: string
  hostId: string
  /** The authenticated peer (or `local` / `steward`) that took it; only it may run under or release it. */
  holder: string
  ownerEpoch: number
  /** Null for actions fenced on organization revision or owner epoch only. */
  turnRevision: string | null
  state: SessionHostReservationState
  heldAt: number
}

export function sessionHostTurnReservationKey(
  conversationId: string,
  ownerEpoch: number,
  turnRevision: string
): string {
  return JSON.stringify(['turn', conversationId, ownerEpoch, turnRevision])
}

/** Recorded by the source before it hands authority to exactly one destination. */
export type SessionHostOwnershipGrant = {
  /** The source's `relocate.relinquish` operation id: single-use. */
  grantId: string
  /** The overall relocation operation. */
  relocation: string
  conversationId: string
  fromHostId: string
  toHostId: string
  /** The epoch the destination will own: the source's epoch + 1. */
  ownerEpoch: number
  provider: SessionHostProviderIdentity
  manifestDigest: string
  issuedAt: number
}

/** The source's durable promise never to execute this conversation again at or below the epoch. */
export type SessionHostRelinquishment = {
  conversationId: string
  hostId: string
  relinquishedEpoch: number
  grantId: string
  at: number
}

/**
 * Whether a destination may consume a grant. Consumption itself must be durable and single-use;
 * this only rejects a grant that names another host, conversation or a stale epoch.
 */
export function sessionHostGrantMismatch(
  grant: SessionHostOwnershipGrant,
  consumer: { hostId: string; conversationId: string; knownEpoch: number | null }
): string | null {
  if (grant.toHostId !== consumer.hostId) {
    return 'The grant names a different destination host.'
  }
  if (grant.conversationId !== consumer.conversationId) {
    return 'The grant names a different conversation.'
  }
  if (grant.fromHostId === grant.toHostId) {
    return 'A grant cannot hand a conversation to the host that already owns it.'
  }
  if (grant.ownerEpoch < 2) {
    return 'A grant always advances the owner epoch past the first.'
  }
  if (consumer.knownEpoch !== null && grant.ownerEpoch <= consumer.knownEpoch) {
    return `The grant is for owner epoch ${grant.ownerEpoch}, but this host already knows epoch ${consumer.knownEpoch}.`
  }
  return null
}
