/**
 * The host's organization record as `t` account-sync entries (session-host-sync-doc.ts), and what
 * other computers' entries and folder stamps mean for ownership here: a person's revocation
 * anywhere, a later change by anyone else, or a synced placement stamp this host did not author
 * takes an agent's ownership back for good. Sync entries describe; they never grant ownership.
 */

import type { Stamped } from './account-sync-session-docs'
import {
  isOrganizationNoteKind,
  ownershipFieldOf,
  type OrganizationChangeKind,
  type OrganizationExecutor,
  type OrganizationKeyState,
  type OrganizationOwnershipField,
  type OrganizationRecord,
  type OrganizationRevocation
} from './session-organization-change'
import type { HostOrganizationEntry } from './session-organization-host'
import type { SessionHostSyncEntry } from './session-host-sync-doc'

type Entry<K extends SessionHostSyncEntry['k']> = Extract<SessionHostSyncEntry, { k: K }>

/** `hist` as this build writes it: the loose schema keeps `r` (revision) and `v` (value after). */
export type HostHistoryEntry = Entry<'hist'> & { r?: string; v?: unknown }

const SUMMARY_MAX = 200
const VALUE_MAX_JSON = 1000
const OWN_VALUE_MAX = 1000

const ms = (iso: string): number => {
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : 0
}

/** One sync operation per target, so a many-target change keeps one bounded row per session. */
export function hostSyncOpId(opId: string, index: number, count: number): string {
  return count === 1 ? opId : `${opId}#${index}`
}

export function hostSyncExecutor(executor: OrganizationExecutor): string {
  switch (executor.kind) {
    case 'app':
      return `app/${executor.feature}`
    case 'launch':
      return `launch/${executor.source}`
    case 'person':
      return `person/${executor.via}`
    case 'pane':
    case 'cli':
    case 'sync':
      return executor.kind
  }
}

function smallValue(value: unknown): { v: unknown } | Record<string, never> {
  const json = JSON.stringify(value ?? null)
  return json.length <= VALUE_MAX_JSON ? { v: value ?? null } : {}
}

/** A `hist` entry for each target the host can name to other computers (it has a digest). */
export function hostHistoryEntries(
  record: OrganizationRecord,
  digestOf: (key: string) => string | undefined,
  keyOf: (index: number) => string | null,
  hostId?: string
): HostHistoryEntry[] {
  // Why not a note: an agent stopped on this computer is this computer's history alone.
  if (record.phase !== 'applied' || isOrganizationNoteKind(record.kind)) {
    return []
  }
  const summary = record.reason?.slice(0, SUMMARY_MAX)
  return record.targets.flatMap((_target, index): HostHistoryEntry[] => {
    const key = keyOf(index)
    const digest = key ? digestOf(key) : undefined
    if (!digest) {
      return []
    }
    return [
      {
        k: 'hist',
        s: digest,
        op: hostSyncOpId(record.opId, index, record.targets.length),
        ch: record.kind,
        by: hostSyncExecutor(record.executor).slice(0, 40),
        ...(hostId ? { h: hostId } : {}),
        at: ms(record.ts),
        ...(summary ? { sum: summary } : {}),
        ...(record.revision ? { r: record.revision } : {}),
        ...(record.after && index < record.after.length ? smallValue(record.after[index]) : {})
      }
    ]
  })
}

/**
 * Revocations this computer only inferred (no provenance found at migration, or heard from
 * sync) stay here: published, a Mac's guess about another host's session would revoke that
 * host's own receipt.
 */
function isPublishedRevocation(why: string): boolean {
  return !why.startsWith('migration/') && !why.startsWith('sync/')
}

/** A key's ownership receipts and the permanent revocations it witnessed, as `own` and `rev`. */
export function hostOwnershipEntries(
  digest: string,
  state: OrganizationKeyState,
  hostId?: string
): SessionHostSyncEntry[] {
  const entries: SessionHostSyncEntry[] = []
  for (const field of ['placement', 'title'] as const) {
    const owned = state.ownership[field]
    const value = owned?.value
    if (owned && (value === null || (typeof value === 'string' && value.length <= OWN_VALUE_MAX))) {
      entries.push({
        k: 'own',
        s: digest,
        f: field,
        r: owned.revision,
        v: value,
        op: owned.opId,
        ...(hostId ? { h: hostId } : {}),
        at: ms(owned.at)
      })
    }
    const revoked = state.revocations[field]
    if (revoked && isPublishedRevocation(revoked.why)) {
      entries.push({
        k: 'rev',
        s: digest,
        f: field,
        op: revoked.opId,
        why: revoked.why.slice(0, 200),
        at: ms(revoked.at)
      })
    }
  }
  return entries
}

/** Whose words the session's title is, once a change set it here. */
export function hostTitleEntry(
  digest: string,
  entry: HostOrganizationEntry | undefined
): SessionHostSyncEntry | null {
  const origin = entry?.values.titleOrigin
  const revision = entry?.revisions.title
  return origin && revision && entry.stamps?.title
    ? { k: 'title', s: digest, o: origin, r: revision, at: ms(entry.stamps.title) }
    : null
}

export type HostSyncRevocation = {
  digest: string
  field: OrganizationOwnershipField
  revocation: OrganizationRevocation
}

export type HostSyncIngest = {
  /** Every other computer's `t` entries, merged. */
  entries: readonly SessionHostSyncEntry[]
  /** The account's winning synced folder per session digest (folder and session documents). */
  placements?: ReadonlyMap<string, Stamped<string | null>>
}

const iso = (at: number): string => new Date(at).toISOString()

/**
 * Revocations other computers' entries call for here, given each digest's state on this host:
 * - a `rev` anywhere: the field is the person's here too, owned or not;
 * - a `hist` entry for an owned field from another operation, after the owned change;
 * - a synced placement stamp that is not this host's own (not the noted echo, newer than the
 *   owned change): an older app, or a Mac whose change never carried a `t` entry.
 */
export function hostSyncRevocations(
  input: HostSyncIngest,
  stateOf: (digest: string) => OrganizationKeyState | undefined,
  selfHostId?: string
): HostSyncRevocation[] {
  const out = new Map<string, HostSyncRevocation>()
  const add = (revocation: HostSyncRevocation): void => {
    const id = `${revocation.digest}\0${revocation.field}`
    if (!out.has(id) && !stateOf(revocation.digest)?.revocations[revocation.field]) {
      out.set(id, revocation)
    }
  }
  for (const entry of input.entries) {
    if (entry.k === 'rev' && stateOf(entry.s)) {
      add({
        digest: entry.s,
        field: entry.f,
        revocation: { at: iso(entry.at), opId: entry.op, why: `sync/${entry.why}`.slice(0, 200) }
      })
    }
    if (entry.k !== 'hist' || (selfHostId && entry.h === selfHostId)) {
      continue
    }
    const field = ownershipFieldOf(entry.ch as OrganizationChangeKind)
    const owned = field ? stateOf(entry.s)?.ownership[field] : undefined
    const history = entry as HostHistoryEntry
    if (
      field &&
      owned &&
      entry.op !== owned.opId &&
      !entry.op.startsWith(`${owned.opId}#`) &&
      history.r !== owned.revision &&
      entry.at > ms(owned.at)
    ) {
      add({
        digest: entry.s,
        field,
        revocation: { at: iso(entry.at), opId: entry.op, why: `sync/${entry.by}`.slice(0, 200) }
      })
    }
  }
  for (const [digest, [, stamp]] of input.placements ?? []) {
    const owned = stateOf(digest)?.ownership.placement
    if (!owned) {
      continue
    }
    const foreign =
      owned.syncStamp !== undefined
        ? stamp !== owned.syncStamp && stamp > owned.syncStamp
        : stamp > ms(owned.at)
    if (foreign) {
      add({
        digest,
        field: 'placement',
        revocation: { at: iso(stamp), opId: `sync:${stamp}`, why: `sync/${stamp}` }
      })
    }
  }
  return [...out.values()]
}

/** Intents another computer sent that no `hist` entry has answered yet: shown pending, never applied. */
export function pendingHostIntents(entries: readonly SessionHostSyncEntry[]): Entry<'int'>[] {
  const answered = new Set(entries.flatMap((entry) => (entry.k === 'hist' ? [entry.op] : [])))
  return entries.filter(
    (entry): entry is Entry<'int'> => entry.k === 'int' && !answered.has(entry.op)
  )
}
