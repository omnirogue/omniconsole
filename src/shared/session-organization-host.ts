/**
 * Organization an execution host commits itself, with no window to apply it (Phase 4, package D):
 * the per-session values its ledger has applied, folded from the applied records (so the ledger
 * stays the one source of truth), and the revisioned apply/read/history/undo contract packages B
 * and E call. docs/reference/session-host-control.md, "Headless organization".
 */

import type { SessionHostRefusal } from './session-host-refusal'
import {
  organizationTargetKey,
  organizationTitleOriginOf,
  organizationValueAt,
  revisionFieldOf,
  type OrganizationChange,
  type OrganizationChangeKind,
  type OrganizationExecutor,
  type OrganizationHistory,
  type OrganizationKeyState,
  type OrganizationRecord,
  type OrganizationTitleOrigin,
  type OrganizationUndoTarget
} from './session-organization-change'

/** The kinds a host commits for its own sessions; folder edits stay with a window. */
export const HOST_ORGANIZATION_KINDS = [
  'move',
  'save',
  'archive',
  'unarchive',
  'title',
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
] as const satisfies readonly OrganizationChangeKind[]
export type HostOrganizationKind = (typeof HOST_ORGANIZATION_KINDS)[number]

const HOST_KINDS: ReadonlySet<string> = new Set(HOST_ORGANIZATION_KINDS)

export function isHostOrganizationKind(kind: string): kind is HostOrganizationKind {
  return HOST_KINDS.has(kind)
}

/** The revision fields (`revisionFieldOf`) a session's host values cover. */
export const HOST_ORGANIZATION_FIELDS = [
  'placement',
  'archived',
  'title',
  'tags',
  'hidden',
  'snooze',
  'deleted'
] as const
export type HostOrganizationField = (typeof HOST_ORGANIZATION_FIELDS)[number]

/**
 * Kinds whose applied records the host folds into its values: its own, and `delete`, which only a
 * window applies (a person's Delete and its Undo) but whose current value main must keep durably
 * (session parity, F4): the bounded history log is no store.
 */
type HostFoldedKind = HostOrganizationKind | 'delete'

function isHostFoldedKind(kind: string): kind is HostFoldedKind {
  return kind === 'delete' || HOST_KINDS.has(kind)
}

export type HostOrganizationValues = {
  /** A folder id, `saved-sessions`, or null for unfiled. */
  placement: string | null
  archived: boolean
  title: string | null
  titleOrigin?: OrganizationTitleOrigin
  tags: string[]
  hidden: boolean
  /** Wake time (epoch ms), or null. */
  snooze: number | null
  /** The person deleted it from the list here; an Undo clears it. */
  deleted: boolean
}

/** One session key as the host knows it; a field never set here reads as its default. */
export type HostOrganizationEntry = {
  values: Partial<HostOrganizationValues>
  /** Per field, the applied change that last set it (`migrated:<ts>` for an imported value). */
  revisions: Partial<Record<HostOrganizationField, string>>
  /** Per field, when that change applied: an older record replayed later never overwrites it. */
  stamps?: Partial<Record<HostOrganizationField, string>>
  /** The newest revision: what `expectedOrganizationRevision` is checked against. */
  revision?: string
  at?: string
  /** The session's account-sync digest, when its canonical key is known. */
  digest?: string
}

/** The organization revision of a session nothing has touched here. */
export const HOST_ORGANIZATION_NO_REVISION = 'org:none'

export function hostOrganizationRevision(entry: HostOrganizationEntry | undefined): string {
  return entry?.revision ?? HOST_ORGANIZATION_NO_REVISION
}

export function migratedRevision(at: string): string {
  return `migrated:${at}`
}

function hostFieldOf(kind: OrganizationChangeKind): HostOrganizationField | null {
  const field = revisionFieldOf(kind)
  return (HOST_ORGANIZATION_FIELDS as readonly string[]).includes(field ?? '')
    ? (field as HostOrganizationField)
    : null
}

/**
 * What one target holds now for the field a kind changes, read the way the window reads it:
 * tag kinds whether it has that tag, snooze the wake time only while it is still ahead.
 */
export function readHostOrganizationValue(
  kind: HostOrganizationKind,
  entry: HostOrganizationEntry | undefined,
  value: unknown,
  nowMs: number
): unknown {
  const values = entry?.values ?? {}
  switch (kind) {
    case 'move':
    case 'save':
      return values.placement ?? null
    case 'archive':
    case 'unarchive':
      return values.archived === true
    case 'title':
      return values.title ?? null
    case 'tag':
    case 'untag':
      return typeof value === 'string' && (values.tags ?? []).includes(value)
    case 'hide':
    case 'unhide':
      return values.hidden === true
    case 'snooze':
      return typeof values.snooze === 'number' && values.snooze > nowMs ? values.snooze : null
  }
}

export type HostOrganizationAfter = { ok: true; after: unknown } | { ok: false; error: string }

/** What a target holds once the change applies here, as the window's store actions leave it. */
export function hostOrganizationAfter(
  kind: HostOrganizationKind,
  value: unknown
): HostOrganizationAfter {
  switch (kind) {
    case 'move':
    case 'save':
      return value === null || (typeof value === 'string' && value.trim().length > 0)
        ? { ok: true, after: value }
        : { ok: false, error: 'A move names a folder id, or null for unfiled. Nothing changed.' }
    case 'archive':
    case 'unarchive':
      return { ok: true, after: kind === 'archive' }
    case 'title':
      if (value !== null && typeof value !== 'string') {
        return { ok: false, error: 'A title is text. Nothing changed.' }
      }
      // Why untrimmed: an Undo must put back the exact words; an empty title resets it.
      return { ok: true, after: typeof value === 'string' && value.trim() ? value : null }
    case 'tag':
    case 'untag':
      return typeof value === 'string' && value.trim()
        ? { ok: true, after: kind === 'tag' }
        : { ok: false, error: 'A tag change names the tag id. Nothing changed.' }
    case 'hide':
    case 'unhide':
      return { ok: true, after: typeof value === 'boolean' ? value : kind === 'hide' }
    case 'snooze':
      return value === null || (typeof value === 'number' && Number.isFinite(value))
        ? { ok: true, after: value }
        : { ok: false, error: 'A snooze names a wake time (epoch ms), or null. Nothing changed.' }
  }
}

function afterAt(record: OrganizationRecord, kind: HostFoldedKind, index: number): unknown {
  if (record.after && index < record.after.length) {
    return record.after[index]
  }
  if (kind === 'delete') {
    return organizationValueAt(record, index) === true
  }
  const derived = hostOrganizationAfter(kind, organizationValueAt(record, index))
  return derived.ok ? derived.after : undefined
}

function withValue(
  values: Partial<HostOrganizationValues>,
  record: OrganizationRecord,
  kind: HostFoldedKind,
  index: number
): Partial<HostOrganizationValues> | null {
  const after = afterAt(record, kind, index)
  if (after === undefined) {
    return null
  }
  switch (kind) {
    case 'delete':
      return { ...values, deleted: after === true }
    case 'move':
    case 'save':
      return { ...values, placement: typeof after === 'string' ? after : null }
    case 'archive':
    case 'unarchive':
      return { ...values, archived: after === true }
    case 'title':
      return {
        ...values,
        title: typeof after === 'string' && after ? after : null,
        titleOrigin: organizationTitleOriginOf(record)
      }
    case 'tag':
    case 'untag': {
      const tag = organizationValueAt(record, index)
      if (typeof tag !== 'string') {
        return null
      }
      const tags = (values.tags ?? []).filter((entry) => entry !== tag)
      return { ...values, tags: after === true ? [...tags, tag] : tags }
    }
    case 'hide':
    case 'unhide':
      return { ...values, hidden: after === true }
    case 'snooze':
      return { ...values, snooze: typeof after === 'number' ? after : null }
  }
}

/**
 * One applied record's effect on the host values of each key it touched (unchanged keys left
 * out). Idempotent: folding the same record again leaves the same values, so a restart may
 * replay records the saved values already hold.
 */
export function foldHostOrganizationRecord(
  record: OrganizationRecord,
  entryOf: (key: string) => HostOrganizationEntry | undefined
): Map<string, HostOrganizationEntry> {
  const next = new Map<string, HostOrganizationEntry>()
  const kind = record.kind
  const field = hostFieldOf(kind)
  if (record.phase !== 'applied' || !field || !isHostFoldedKind(kind)) {
    return next
  }
  const revision = record.revision ?? record.opId
  record.targets.forEach((target, index) => {
    const key = organizationTargetKey(target)
    if (!key || key.startsWith('folder:')) {
      return
    }
    const entry = next.get(key) ?? entryOf(key) ?? { values: {}, revisions: {} }
    const setAt = entry.stamps?.[field]
    const values = setAt && record.ts < setAt ? null : withValue(entry.values, record, kind, index)
    if (!values) {
      return
    }
    const newest = !entry.at || record.ts >= entry.at
    next.set(key, {
      ...entry,
      values,
      revisions: { ...entry.revisions, [field]: revision },
      stamps: { ...entry.stamps, [field]: record.ts },
      ...(newest ? { revision, at: record.ts } : {})
    })
  })
  return next
}

// ---- The contract B and E call (in-process on the execution host; A carries it on the wire) ----

/** A change for the host to commit; its executor is derived by the caller, never the payload. */
export type HostOrganizationRequest = Omit<OrganizationChange, 'opId'> & {
  /** The host operation id (A's `operationId`) makes a retry return the recorded outcome. */
  opId?: string
  /** `observe`'s `organizationRevision` for every target; any later change refuses. */
  expectedOrganizationRevision?: string
}

/** How it was applied: by this host's own values (no window), or by its window. */
export type HostOrganizationMode = 'headless' | 'window'

export type HostOrganizationOutcome =
  | {
      status: 'applied'
      opId: string
      mode: HostOrganizationMode
      before: unknown[]
      after: unknown[]
      revision: string
      /** Each target's organization revision after it, aligned with the targets. */
      organizationRevisions: string[]
      /** The same operation id was already committed with the same change. */
      replay?: true
      /** Applied, but its trail line could not be written. */
      auditError?: string
    }
  /** Nothing changed; `refusal.code` is a session host refusal code. */
  | { status: 'refused'; opId: string; refusal: SessionHostRefusal }
  /** Nothing changed: the window refused it. */
  | { status: 'failed'; opId: string; error: string }

export type HostOrganizationSession = {
  key: string
  digest?: string
  values: HostOrganizationValues
  revisions: Partial<Record<HostOrganizationField, string>>
  organizationRevision: string
  ownership: OrganizationKeyState
  /** Prepared before a crash and not reconciled yet: no automation acts on the key until then. */
  pending: string[]
}

export type HostOrganizationRead = {
  /** Null until migration imported existing values and provenance: no automation before that. */
  migratedAt: string | null
  sessions: HostOrganizationSession[]
}

export type HostOrganizationUndoOutcome = {
  opId: string
  undone: number
  total: number
  skipped: OrganizationUndoTarget[]
  outcome?: HostOrganizationOutcome
  error?: string
}

/** Existing values a window (or a Mac, for an SSH host) held before this host committed anything. */
export type HostOrganizationMigrationEntry = {
  key: string
  digest?: string
  values: Partial<HostOrganizationValues>
}

export type HostOrganizationMigration = {
  entries: HostOrganizationMigrationEntry[]
  /** The last batch: automation is admitted from now on. */
  complete?: boolean
}

export type HostOrganizationMigrationResult = {
  imported: number
  /** Fields that held another value than this host recorded: the value found wins, as the person's. */
  drifted: { key: string; field: HostOrganizationField; opId: string }[]
  /** Placements and titles with no provenance, now the person's for good. */
  personOwned: { key: string; field: 'placement' | 'title' }[]
  migratedAt: string | null
}

/** A window's answer for the headless changes it was handed (`sessionOrganization.hostAdopted`). */
export type HostOrganizationAdoption = {
  adopted: string[]
  /** A target the window holds another value for: the window's value wins. */
  conflicts: { opId: string; key: string; value: unknown }[]
}

/**
 * The host's organization service. `apply` refuses automation until `migrate` completes, checks
 * `expectedOrganizationRevision` and the ownership revision, and commits through the same ledger
 * (trail, history, ownership) as the window, headless or through the window when one is present.
 */
export type HostOrganizationApi = {
  readonly ready: Promise<void>
  read: (keys?: readonly string[]) => HostOrganizationRead
  apply: (request: HostOrganizationRequest) => Promise<HostOrganizationOutcome>
  history: (key: string, options?: { aliases?: readonly string[] }) => Promise<OrganizationHistory>
  undo: (
    opId: string,
    options?: {
      executor?: OrganizationExecutor
      mintOpId?: string
      expectedOrganizationRevision?: string
    }
  ) => Promise<HostOrganizationUndoOutcome>
  migrate: (migration: HostOrganizationMigration) => Promise<HostOrganizationMigrationResult>
}
