/**
 * Revision-bound ownership, shared by main's history store (authoritative) and the window's
 * mirror so both reach the same answer from the same record. The steward owns a placement or
 * title only while its own applied change still holds the field; any other change takes it
 * back for good. See docs/reference/session-organization-change-path.md.
 */

import {
  appliedRevision,
  mayEstablishOwnership,
  organizationTargetKey,
  organizationValueAt,
  ownershipFieldOf,
  revocationFor,
  type OrganizationExecutor,
  type OrganizationKeyState,
  type OrganizationOwnership,
  type OrganizationOwnershipField,
  type OrganizationRecord,
  type OrganizationRevocation
} from './session-organization-change'

export const SESSION_ORGANIZATION_OWNERSHIP_RPC = {
  /** Ownership and revocations per key, as main holds them. */
  snapshot: 'sessionOrganization.ownership',
  syncStamps: 'sessionOrganization.syncStamps',
  migrateKeys: 'sessionOrganization.migrateKeys',
  seed: 'sessionOrganization.seedOwnership'
} as const

export const ORGANIZATION_OWNERSHIP_FIELDS: readonly OrganizationOwnershipField[] = [
  'placement',
  'title'
]
const OWNERSHIP_FIELDS = ORGANIZATION_OWNERSHIP_FIELDS

/** The sync stamp this computer gave the owned change, so its echo is not taken for another's. */
export type OwnershipSyncStamp = {
  key: string
  field: OrganizationOwnershipField
  opId: string
  stamp: number
}

/** A pane's key folded onto its provider key; `placementFrom` when the provider key took the pane's folder. */
export type OwnershipKeyMove = { from: string; to: string; placementFrom: boolean }

/** A session a 1a launch filed into its batch folder, where it still is. */
export type OwnershipSeed = { key: string; value: string; batchId: string; at: string }

export const emptyOrganizationKeyState = (): OrganizationKeyState => ({
  ownership: {},
  revocations: {}
})

export function isEmptyOrganizationKeyState(state: OrganizationKeyState): boolean {
  return Object.keys(state.ownership).length === 0 && Object.keys(state.revocations).length === 0
}

export function sameOwnedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/** A person's change and one that sync applied are recorded after they happen, never prepared. */
export function isRecordedAfterApplying(executor: OrganizationExecutor): boolean {
  return executor.kind === 'person' || executor.kind === 'sync'
}

/** Sync handing back the owned change itself: its value, under the stamp noted for it. */
export function isOwnSyncEcho(
  owned: OrganizationOwnership | undefined,
  value: unknown,
  stamp: number
): boolean {
  return owned?.syncStamp === stamp && sameOwnedValue(owned.value, value)
}

function revocationWhy(record: OrganizationRecord): string {
  const { executor } = record
  if (record.revisionUnchecked) {
    return `${executor.kind}/unchecked`
  }
  switch (executor.kind) {
    case 'sync':
      return `sync/${executor.stamp}`
    case 'app':
      return `app/${executor.feature}`
    case 'launch':
      return `launch/${executor.source}`
    case 'person':
      return `person/${executor.via}`
    case 'pane':
    case 'cli':
      return executor.kind
  }
}

function revoke(
  state: OrganizationKeyState,
  field: OrganizationOwnershipField,
  revocation: OrganizationRevocation
): OrganizationKeyState {
  const { [field]: _dropped, ...ownership } = state.ownership
  return { ownership, revocations: { ...state.revocations, [field]: revocation } }
}

/**
 * A field taken back for good without a change to its value (another computer's person, sync
 * from a stamp this one did not author, a migration that found no provenance). The first
 * revocation of a field stays; the same object comes back when nothing changes.
 */
export function revokedOrganizationKeyState(
  state: OrganizationKeyState,
  field: OrganizationOwnershipField,
  revocation: OrganizationRevocation
): OrganizationKeyState {
  return state.revocations[field] ? state : revoke(state, field, revocation)
}

/**
 * One applied record's effect on its `index`th target (the same object when nothing changes):
 * a person's change revokes for good; a revision-checked non-person change owns the field unless
 * it was revoked before; key migration carries ownership and makes none; anything else (another
 * device through sync, a restore, a window that skipped the revision check) takes back the
 * ownership it finds, except sync handing back the owned change itself.
 */
export function nextOrganizationKeyState(
  state: OrganizationKeyState,
  record: OrganizationRecord,
  index: number
): OrganizationKeyState {
  const field = ownershipFieldOf(record.kind)
  const { executor } = record
  if (
    record.phase !== 'applied' ||
    !field ||
    (executor.kind === 'app' && executor.feature === 'key-migration')
  ) {
    return state
  }
  const person = revocationFor(record)
  if (person) {
    return revoke(state, person.field, person.revocation)
  }
  const value =
    record.after && index < record.after.length
      ? record.after[index]
      : organizationValueAt(record, index)
  if (mayEstablishOwnership(record)) {
    // Why never after a revocation: once the field was the person's, it stays theirs. Nor for a
    // change that left the value as it was: whoever put it there, it was not this change.
    const unchanged =
      record.before !== undefined &&
      index < record.before.length &&
      sameOwnedValue(record.before[index], value)
    if (state.revocations[field] || unchanged) {
      return state
    }
    const owned: OrganizationOwnership = {
      value,
      revision: record.revision ?? appliedRevision(record),
      by: executor.kind,
      opId: record.opId,
      at: record.ts
    }
    return { ...state, ownership: { ...state.ownership, [field]: owned } }
  }
  const owned = state.ownership[field]
  if (!owned || (executor.kind === 'sync' && isOwnSyncEcho(owned, value, executor.stamp))) {
    return state
  }
  return revoke(state, field, { at: record.ts, opId: record.opId, why: revocationWhy(record) })
}

/** Every target key of an applied record with its next state (unchanged keys left out). */
export function organizationKeyStatesAfter(
  record: OrganizationRecord,
  stateOf: (key: string) => OrganizationKeyState
): Map<string, OrganizationKeyState> {
  const next = new Map<string, OrganizationKeyState>()
  record.targets.forEach((target, index) => {
    const key = organizationTargetKey(target)
    if (!key) {
      return
    }
    const before = next.get(key) ?? stateOf(key)
    const after = nextOrganizationKeyState(before, record, index)
    if (after !== before) {
      next.set(key, after)
    }
  })
  return next
}

/** Notes the stamp on the owned change it was authored for (never on a later or earlier one). */
export function withSyncStamp(
  state: OrganizationKeyState,
  { field, opId, stamp }: Omit<OwnershipSyncStamp, 'key'>
): OrganizationKeyState {
  const owned = state.ownership[field]
  if (!owned || owned.opId !== opId || owned.syncStamp !== undefined) {
    return state
  }
  return { ...state, ownership: { ...state.ownership, [field]: { ...owned, syncStamp: stamp } } }
}

/**
 * A pane's state folded onto its provider key: the placement goes with whichever key's folder the
 * provider key keeps, the title with the pane (its tab keeps its title), and every revocation of
 * either key stays, so a field the person touched under either key is still theirs.
 */
export function migrateOrganizationKeyState(
  from: OrganizationKeyState,
  to: OrganizationKeyState,
  placementFrom: boolean
): OrganizationKeyState {
  const [placed, other] = placementFrom ? [from, to] : [to, from]
  const state = emptyOrganizationKeyState()
  const carried = {
    placement: {
      revoked: placed.revocations.placement ?? other.revocations.placement,
      owned: placed.ownership.placement
    },
    title: {
      revoked: from.revocations.title ?? to.revocations.title,
      owned: from.ownership.title ?? to.ownership.title
    }
  }
  for (const field of OWNERSHIP_FIELDS) {
    const { revoked, owned } = carried[field]
    if (revoked) {
      state.revocations[field] = revoked
    } else if (owned) {
      state.ownership[field] = owned
    }
  }
  return state
}

/**
 * A 1a batch filing, owned by its launch only while nothing is recorded for the session's
 * placement (no ownership, revocation or change); otherwise the state is left as it is.
 */
export function seededOrganizationKeyState(
  state: OrganizationKeyState,
  seed: OwnershipSeed,
  hasPlacementHistory: boolean
): OrganizationKeyState {
  if (state.ownership.placement || state.revocations.placement || hasPlacementHistory) {
    return state
  }
  const revision = `seed:${seed.batchId}`
  const placement: OrganizationOwnership = {
    value: seed.value,
    revision,
    by: 'launch',
    opId: revision,
    at: seed.at
  }
  return { ...state, ownership: { ...state.ownership, placement } }
}

function isOwnership(value: unknown): value is OrganizationOwnership {
  const entry = value as Partial<OrganizationOwnership> | null
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.revision === 'string' &&
    typeof entry.opId === 'string' &&
    typeof entry.by === 'string' &&
    typeof entry.at === 'string' &&
    (entry.syncStamp === undefined || typeof entry.syncStamp === 'number')
  )
}

function isRevocation(value: unknown): value is OrganizationRevocation {
  const entry = value as Partial<OrganizationRevocation> | null
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    typeof entry.opId === 'string' &&
    typeof entry.why === 'string'
  )
}

/** A saved key state, field by field; a revoked field never keeps ownership. Null when empty. */
export function parseOrganizationKeyState(raw: unknown): OrganizationKeyState | null {
  const value = raw as Partial<OrganizationKeyState> | null
  const state = emptyOrganizationKeyState()
  for (const field of OWNERSHIP_FIELDS) {
    const revocation = value?.revocations?.[field]
    const owned = value?.ownership?.[field]
    if (isRevocation(revocation)) {
      state.revocations[field] = revocation
    } else if (isOwnership(owned)) {
      state.ownership[field] = owned
    }
  }
  return isEmptyOrganizationKeyState(state) ? null : state
}

/**
 * The window's copy of one key after reading main's (authoritative): main's ownership, every
 * revocation either side holds (the window may have taken one back that main has not heard of
 * yet), and a sync stamp the window noted that main has not received, to send again.
 */
export function adoptedOrganizationKeyState(
  mine: OrganizationKeyState,
  theirs: OrganizationKeyState
): { state: OrganizationKeyState; resend: Omit<OwnershipSyncStamp, 'key'>[] } {
  const state = emptyOrganizationKeyState()
  const resend: Omit<OwnershipSyncStamp, 'key'>[] = []
  for (const field of OWNERSHIP_FIELDS) {
    const revoked = theirs.revocations[field] ?? mine.revocations[field]
    const owned = theirs.ownership[field]
    const local = mine.ownership[field]
    if (revoked) {
      state.revocations[field] = revoked
    } else if (
      owned &&
      owned.syncStamp === undefined &&
      local?.opId === owned.opId &&
      local.syncStamp !== undefined
    ) {
      state.ownership[field] = { ...owned, syncStamp: local.syncStamp }
      resend.push({ field, opId: owned.opId, stamp: local.syncStamp })
    } else if (owned) {
      state.ownership[field] = owned
    }
  }
  return { state, resend }
}

export type OwnedRevisionRefusal =
  | { reason: 'yours'; why: string }
  | { reason: 'not-owned' }
  | { reason: 'changed-since'; current: string }

/**
 * Whether a change that expects `expectedRevision` of an owned field may go ahead: only while the
 * field is still owned at exactly that revision. Null allows.
 */
export function ownedRevisionRefusal(
  state: OrganizationKeyState,
  field: OrganizationOwnershipField,
  expectedRevision: string
): OwnedRevisionRefusal | null {
  const revoked = state.revocations[field]
  if (revoked) {
    return { reason: 'yours', why: revoked.why }
  }
  const owned = state.ownership[field]
  if (!owned) {
    return { reason: 'not-owned' }
  }
  return owned.revision === expectedRevision
    ? null
    : { reason: 'changed-since', current: owned.revision }
}
