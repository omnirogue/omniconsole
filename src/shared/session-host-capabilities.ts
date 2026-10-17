/**
 * Capabilities for Phase 4 session host control, each negotiated independently before its fields
 * are sent. Paired runtimes list them in `status.capabilities`; SSH relays in an optional
 * `sessionHost` field of `pty.getCapabilities`. Nothing advertises them until a host implements the
 * methods (package A): an advertised capability without its handler is the bug this avoids.
 */

import {
  isSessionHostId,
  isSessionHostIncarnation,
  type SessionHostIdentity
} from './session-host-identity'

import {
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES,
  SESSION_HOST_STATS_CAPABILITY,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  type SessionHostCapability
} from './session-host-capability-names'

export {
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_CAPABILITIES,
  SESSION_HOST_CLIENT_CAPABILITIES,
  SESSION_HOST_STATS_CAPABILITY,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY
} from './session-host-capability-names'
export type { SessionHostCapability } from './session-host-capability-names'

export const SESSION_HOST_RELOCATION_PROVIDERS = ['claude', 'codex'] as const
export type SessionHostRelocationProvider = (typeof SESSION_HOST_RELOCATION_PROVIDERS)[number]

export const SESSION_RELOCATION_CAPABILITY_BY_PROVIDER: Record<
  SessionHostRelocationProvider,
  SessionHostCapability
> = {
  claude: SESSION_RELOCATION_CLAUDE_CAPABILITY,
  codex: SESSION_RELOCATION_CODEX_CAPABILITY
}

/** Every other surface rides on owner epochs, reservations and caller authority. */
export const SESSION_HOST_CAPABILITY_PREREQUISITES: Record<
  SessionHostCapability,
  readonly SessionHostCapability[]
> = {
  [SESSION_CONTROL_OWNER_CAPABILITY]: [],
  [SESSION_ORGANIZATION_HOST_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  [SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  [SESSION_RELOCATION_CLAUDE_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  [SESSION_RELOCATION_CODEX_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  // Why owner only here: it also needs one provider's relocation, which a host checks when advertising.
  [SESSION_RELOCATION_BUNDLE_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  [SESSION_WAITS_REMOTE_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  [SESSION_CONTROL_DELIVERY_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY],
  // Why owner: a host advertises nothing without owner control, so stats ride on the same switch.
  [SESSION_HOST_STATS_CAPABILITY]: [SESSION_CONTROL_OWNER_CAPABILITY]
}

const KNOWN = new Set<string>(SESSION_HOST_CAPABILITIES)
// Why: a peer speaking a newer version of a family (`session-control.owner.v2`) is reported, not
// silently treated as speaking none.
const FAMILY = /^session-(control|organization|transfer|relocation|waits)\.[a-z0-9.-]+\.v\d+$/

export function isSessionHostCapability(value: unknown): value is SessionHostCapability {
  return typeof value === 'string' && KNOWN.has(value)
}

export function isSessionHostCapabilityFamily(value: string): boolean {
  return FAMILY.test(value)
}

export const SSH_SESSION_HOST_CAPABILITIES_FIELD = 'sessionHost' as const
export const SESSION_HOST_MAX_ADVERTISED = 64
// Why a separate bound: a runtime's full list carries every unrelated capability too.
const MAX_RAW_CAPABILITIES = 4096

/**
 * What the other side said. `absent`: it predates Phase 4 (no field, or no family names at all).
 * `malformed`: it said something unreadable, which is refused like `absent`, never guessed at.
 * `identity` is the advertising host's; null only for a client's declaration.
 */
export type SessionHostAdvertisement =
  | { status: 'advertised'; capabilities: readonly string[]; identity: SessionHostIdentity | null }
  | { status: 'absent' }
  | { status: 'malformed'; detail: string }

function capabilityList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_RAW_CAPABILITIES) {
    return null
  }
  const names = value.filter((entry): entry is string => typeof entry === 'string')
  const family = names.filter(isSessionHostCapabilityFamily)
  return names.length === value.length && family.length <= SESSION_HOST_MAX_ADVERTISED
    ? family
    : null
}

function identityOf(value: unknown): SessionHostIdentity | null | 'malformed' {
  if (value === undefined) {
    return null
  }
  const record = value as { hostId?: unknown; incarnation?: unknown } | null
  return record && isSessionHostId(record.hostId) && isSessionHostIncarnation(record.incarnation)
    ? { hostId: record.hostId, incarnation: record.incarnation }
    : 'malformed'
}

/**
 * A paired runtime's `runtime.status`. Family names in `capabilities`, identity in the optional
 * `sessionHost: { hostId, incarnation }` (the incarnation is the process's `runtimeId`).
 */
export function readRuntimeSessionHostAdvertisement(status: unknown): SessionHostAdvertisement {
  const record = status as { capabilities?: unknown; sessionHost?: unknown } | null
  if (!record || typeof record !== 'object') {
    return { status: 'malformed', detail: 'runtime status is not an object' }
  }
  if (record.capabilities === undefined) {
    return { status: 'absent' }
  }
  const names = capabilityList(record.capabilities)
  if (!names) {
    return { status: 'malformed', detail: 'runtime capabilities are not a list of names' }
  }
  if (names.length === 0) {
    return { status: 'absent' }
  }
  const identity = identityOf(record.sessionHost)
  // Why: without its registry identity a negotiation cannot be bound, so aliases could split owners.
  if (identity === 'malformed' || identity === null) {
    return { status: 'malformed', detail: 'runtime sessionHost identity is missing or unreadable' }
  }
  return { status: 'advertised', capabilities: names, identity }
}

/** An SSH relay's `pty.getCapabilities`; older relays have no `sessionHost` field at all. */
export function readRelaySessionHostAdvertisement(result: unknown): SessionHostAdvertisement {
  const field = (result as Record<string, unknown> | null)?.[SSH_SESSION_HOST_CAPABILITIES_FIELD]
  if (field === undefined) {
    return { status: 'absent' }
  }
  const record = field as { capabilities?: unknown; hostId?: unknown; incarnation?: unknown } | null
  const names = capabilityList(record?.capabilities)
  if (!record || typeof record !== 'object' || !names) {
    return { status: 'malformed', detail: 'relay sessionHost capabilities are unreadable' }
  }
  if (names.length === 0) {
    return { status: 'absent' }
  }
  const identity = identityOf({ hostId: record.hostId, incarnation: record.incarnation })
  if (identity === 'malformed' || identity === null) {
    return { status: 'malformed', detail: 'relay sessionHost identity is missing or unreadable' }
  }
  return { status: 'advertised', capabilities: names, identity }
}

/** A client's declaration on its authenticated connection; undefined means it declared nothing. */
export function readClientSessionHostDeclaration(
  declared: readonly string[] | undefined
): SessionHostAdvertisement {
  if (declared === undefined) {
    return { status: 'absent' }
  }
  const names = capabilityList(declared)
  if (!names) {
    return { status: 'malformed', detail: 'client capabilities are not a list of names' }
  }
  return names.length === 0
    ? { status: 'absent' }
    : { status: 'advertised', capabilities: names, identity: null }
}
