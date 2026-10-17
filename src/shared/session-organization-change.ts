/**
 * One organization change (a move, archive, re-title or folder edit) as every path records it:
 * who acted, why, and the phases it went through. Main keeps the history and the trail; see
 * docs/reference/session-organization-change-path.md.
 */

import type { SessionWorkflowAnchorRef } from './session-workflow-anchor'
import { sessionBatchRequestExcerpt } from './session-batch-origin'
import { ORGANIZATION_LAUNCH_SOURCES } from './session-organization-launch-sources'
import {
  ORGANIZATION_APP_FEATURES,
  ORGANIZATION_WIRE_APP_FEATURES
} from './session-organization-app-features'

export const SESSION_ORGANIZATION_RPC = {
  prepare: 'sessionOrganization.prepare',
  settle: 'sessionOrganization.settle',
  history: 'sessionOrganization.history',
  recent: 'sessionOrganization.recent',
  undoPlan: 'sessionOrganization.undoPlan',
  reconcile: 'sessionOrganization.reconcile',
  /** `omni session organize|tag|hide|unhide|snooze` (session-organize.ts). */
  organize: 'sessionOrganization.organize',
  /** The window's History line for an archive that put an idle agent to sleep. */
  noteArchiveSleep: 'sessionOrganization.noteArchiveSleep',
  /** main's Stage A1, open-ask and pending reading before an archive sleeps an agent. */
  archiveSleepReading: 'sessionOrganization.archiveSleepReading'
} as const

export const ORGANIZATION_PERSON_SURFACES = ['sidebar', 'work', 'notice', 'pane-rename'] as const
export { ORGANIZATION_APP_FEATURES, ORGANIZATION_LAUNCH_SOURCES, ORGANIZATION_WIRE_APP_FEATURES }

/** Who made the change. Only `pane` is proven (launch evidence); `cli` is the plain local CLI. */
export type OrganizationExecutor =
  | { kind: 'person'; via: (typeof ORGANIZATION_PERSON_SURFACES)[number] }
  | { kind: 'pane'; paneKey: string; title: string }
  | { kind: 'cli' }
  | { kind: 'launch'; source: (typeof ORGANIZATION_LAUNCH_SOURCES)[number] }
  | { kind: 'sync'; stamp: number }
  | { kind: 'app'; feature: (typeof ORGANIZATION_APP_FEATURES)[number] }

export function isStewardExecutor(executor: OrganizationExecutor): boolean {
  return executor.kind === 'app' && executor.feature === 'steward'
}

export type OrganizationExecutorKind = OrganizationExecutor['kind']
export const ORGANIZATION_EXECUTOR_KINDS = [
  'person',
  'pane',
  'cli',
  'launch',
  'sync',
  'app'
] as const satisfies readonly OrganizationExecutorKind[]

/** The kinds a window, CLI or runtime may prepare or settle. */
export const ORGANIZATION_WIRE_CHANGE_KINDS = [
  'move',
  'archive',
  'unarchive',
  'delete',
  'title',
  'save',
  'finish-action',
  'folder.create',
  'folder.rename',
  'folder.move',
  'folder.delete',
  'folder.color',
  'folder.reorder',
  /** A project's settings (#907) on its folder; the value is the settings, or null for none. */
  'folder.project',
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
] as const
/**
 * History-only kinds: something the app already did that changes no organized value (`sleep`:
 * an archive stopped the conversation's idle agent; opening it resumes). Recorded by main alone,
 * applied in one line, never owned, synced or undone.
 */
export const ORGANIZATION_NOTE_KINDS = ['sleep'] as const
export const ORGANIZATION_CHANGE_KINDS = [
  ...ORGANIZATION_WIRE_CHANGE_KINDS,
  ...ORGANIZATION_NOTE_KINDS
] as const
export type OrganizationChangeKind = (typeof ORGANIZATION_CHANGE_KINDS)[number]

const NOTE_KINDS: ReadonlySet<string> = new Set(ORGANIZATION_NOTE_KINDS)

export function isOrganizationNoteKind(kind: string): boolean {
  return NOTE_KINDS.has(kind)
}

export const ORGANIZATION_TITLE_ORIGINS = ['generated', 'yours', 'unknown'] as const
export type OrganizationTitleOrigin = (typeof ORGANIZATION_TITLE_ORIGINS)[number]

/** What `omni terminal rename` / `session launch --title` say about a title; both optional. */
export type TerminalRenameProvenance = {
  origin?: OrganizationTitleOrigin
  source?: 'session-launch'
}

/** A session (by folder-membership key, pane or tab) or a folder the change touched. */
export type OrganizationTarget = {
  sessionKey?: string
  tabId?: string
  paneKey?: string
  folderId?: string
  /** A pane-less workflow anchor in that tab, by controller and run, so a check finds it exactly. */
  workflow?: SessionWorkflowAnchorRef
}

/**
 * Values by kind: `move` a folder id (`saved-sessions` for the Saved root) or null for unfiled;
 * `archive`/`unarchive`/`delete`/`hide`/`unhide` the resulting boolean; `snooze` the wake time
 * (epoch ms) or null; `tag`/`untag` the tag id (each target's before/after is whether it has
 * that tag); `title` the title; folder kinds their fields. A relayed CLI move is prepared with
 * the folder reference it named (id or path); its applied record carries the resolved id.
 * Many targets are one change with one reason: one prepared and one applied record, one Undo.
 */
export type OrganizationChange = {
  /** Minted by main for CLI and launch changes, by the renderer otherwise. */
  opId: string
  kind: OrganizationChangeKind
  targets: OrganizationTarget[]
  value: unknown
  /** Per target, aligned with `targets`, when they take different values (an Undo). */
  values?: unknown[]
  executor: OrganizationExecutor
  /** Titles only. */
  origin?: OrganizationTitleOrigin
  reason?: string
  /** The person's own words that asked for it. */
  request?: string
  evidence?: string
  /** Refused when a target's current revision differs. */
  expectedRevision?: string
  /** An Undo is the inverse change with this set, never a kind of its own. */
  undoOf?: string
}

export type OrganizationPhase = 'prepared' | 'applied' | 'failed'

export type OrganizationRecord = OrganizationChange & {
  phase: OrganizationPhase
  ts: string
  /** Per target, aligned with `targets`; absent when not known (never a partial array). */
  before?: unknown[]
  after?: unknown[]
  /** Applied only: see `appliedRevision`. */
  revision?: string
  /** Failed only: a message, or `interrupted` / `no-window`. */
  error?: string
  /** Applied at the next start after a crash left only the prepared line. */
  reconciled?: true
  /** A window that predates the revision check applied it, so it establishes no ownership. */
  revisionUnchecked?: true
  /**
   * Committed by the execution host's own metadata applier, with no window to apply it
   * (session-organization-host.ts); a window on that host adopts it at its next start.
   */
  headless?: true
}

export const ORGANIZATION_INTERRUPTED = 'interrupted'
export const ORGANIZATION_NO_WINDOW = 'no-window'

/** The change body a trail line carries, so a restart can rebuild history and reconcile. */
export type OrganizationTrailBody = Pick<
  OrganizationRecord,
  | 'kind'
  | 'targets'
  | 'value'
  | 'values'
  | 'before'
  | 'after'
  | 'evidence'
  | 'undoOf'
  | 'error'
  | 'reconciled'
  | 'revisionUnchecked'
  | 'headless'
>

export type OrganizationOwnershipField = 'placement' | 'title'

export type OrganizationOwnership = {
  value: unknown
  revision: string
  /** Attached once the change syncs (WP-B). */
  syncStamp?: number
  by: OrganizationExecutorKind
  opId: string
  at: string
}

/** Permanent: kept apart from the rolling history. `why` is `<executor kind>/<surface>`. */
export type OrganizationRevocation = { at: string; opId: string; why: string }

export type OrganizationKeyState = {
  ownership: Partial<Record<OrganizationOwnershipField, OrganizationOwnership>>
  revocations: Partial<Record<OrganizationOwnershipField, OrganizationRevocation>>
}

/** `sessionOrganization.history`: newest first, plus ownership, revocations and unreconciled ops. */
export type OrganizationHistory = OrganizationKeyState & {
  key: string
  entries: OrganizationRecord[]
  /** Prepared before a crash and not reconciled yet: no ownership, no Undo. */
  pending: OrganizationRecord[]
}

export type OrganizationUndoTarget = {
  target: OrganizationTarget
  status: 'undo' | 'changed-since' | 'not-undoable'
  /** The value it must still hold for the Undo to apply (the change's `after`). */
  expected?: unknown
  /** The later change that touched it (changed-since). */
  laterOpId?: string
  detail?: string
}

export type OrganizationUndoPlan = {
  opId: string
  /** Puts back every target still as the change left it; null when none is. */
  inverse: Omit<OrganizationChange, 'opId' | 'executor'> | null
  targets: OrganizationUndoTarget[]
  /** Some, not all, targets can be undone. */
  partial: boolean
}

/** Sent with a relayed CLI or launch mutation; an older window ignores it. */
/** `evidence`: a steward close's proof, which the window checks before closing (older ones ignore it). */
export type OrganizationRelayedChange = Pick<
  OrganizationChange,
  'opId' | 'executor' | 'origin' | 'reason' | 'request' | 'expectedRevision' | 'evidence'
>

/** A window that understood `change` answers with what it resolved and changed. */
export type OrganizationRelayedOutcome = {
  opId: string
  targets: OrganizationTarget[]
  value: unknown
  /** Per target, when they took different values. */
  values?: unknown[]
  before?: unknown[]
  after?: unknown[]
}

/** Startup reconciliation: does the interrupted change hold in the window now (null: can't tell)? */
export type OrganizationProbeAnswer = {
  opId: string
  holds: boolean | null
  targets?: OrganizationTarget[]
  value?: unknown
  after?: unknown[]
}

export function isPersonExecutor(
  executor: OrganizationExecutor
): executor is Extract<OrganizationExecutor, { kind: 'person' }> {
  return executor.kind === 'person'
}

export function organizationValueAt(
  change: Pick<OrganizationChange, 'value' | 'values'>,
  index: number
): unknown {
  return change.values ? change.values[index] : change.value
}

/** An applied change's revision: its opId, or `sync:<stamp>` when sync applied it. */
export function appliedRevision(change: Pick<OrganizationChange, 'opId' | 'executor'>): string {
  return change.executor.kind === 'sync' ? `sync:${change.executor.stamp}` : change.opId
}

/** The owned field a kind changes: only placement and title carry ownership. */
export function ownershipFieldOf(kind: OrganizationChangeKind): OrganizationOwnershipField | null {
  return kind === 'move' || kind === 'save' ? 'placement' : kind === 'title' ? 'title' : null
}

const REVISION_FIELDS: Partial<Record<OrganizationChangeKind, string>> = {
  move: 'placement',
  save: 'placement',
  archive: 'archived',
  unarchive: 'archived',
  delete: 'deleted',
  title: 'title',
  'folder.move': 'folder.place',
  'folder.rename': 'folder.name',
  'folder.color': 'folder.color',
  'folder.project': 'folder.project',
  // Why one field for every tag: any later tag change counts as "changed since" (the safe side).
  tag: 'tags',
  untag: 'tags',
  hide: 'hidden',
  unhide: 'hidden',
  snooze: 'snooze'
}

/** What a revision guards: a later change to the same field of a target means "changed since". */
export function revisionFieldOf(kind: OrganizationChangeKind): string | null {
  return REVISION_FIELDS[kind] ?? null
}

const INVERSE_KINDS: Partial<Record<OrganizationChangeKind, OrganizationChangeKind>> = {
  move: 'move',
  archive: 'unarchive',
  unarchive: 'archive',
  delete: 'delete',
  title: 'title',
  'folder.move': 'folder.move',
  'folder.rename': 'folder.rename',
  'folder.color': 'folder.color',
  'folder.project': 'folder.project',
  tag: 'untag',
  untag: 'tag',
  hide: 'unhide',
  unhide: 'hide',
  snooze: 'snooze'
}

/** Kinds whose value names what was toggled (a tag), so their inverse keeps the value. */
export function isOrganizationToggleKind(kind: OrganizationChangeKind): boolean {
  return kind === 'tag' || kind === 'untag'
}

/** The kind that puts a change back by value; null when Undo needs the folder-tree snapshot. */
export function inverseOrganizationKind(
  kind: OrganizationChangeKind
): OrganizationChangeKind | null {
  return INVERSE_KINDS[kind] ?? null
}

/**
 * Only an applied record from a non-person executor makes a placement or title the steward's.
 * Never sync (another device, actor unknown), key migration or restore (they carry ownership,
 * not create it), nor a change a window applied without the revision check. The steward itself
 * owns placements only: it never re-titles in Phase 2.
 */
export function mayEstablishOwnership(record: OrganizationRecord): boolean {
  const { executor } = record
  const field = ownershipFieldOf(record.kind)
  return (
    record.phase === 'applied' &&
    record.revisionUnchecked !== true &&
    field !== null &&
    executor.kind !== 'person' &&
    executor.kind !== 'sync' &&
    !(
      executor.kind === 'app' &&
      (executor.feature === 'key-migration' || executor.feature === 'restore')
    ) &&
    !(isStewardExecutor(executor) && field === 'title')
  )
}

/** A person's applied placement or title change: the field is theirs, permanently. */
export function revocationFor(
  record: OrganizationRecord
): { field: OrganizationOwnershipField; revocation: OrganizationRevocation } | null {
  const field = ownershipFieldOf(record.kind)
  if (record.phase !== 'applied' || !field || !isPersonExecutor(record.executor)) {
    return null
  }
  return {
    field,
    revocation: { at: record.ts, opId: record.opId, why: `person/${record.executor.via}` }
  }
}

/**
 * The origin a title change leaves: what the change says; an Undo puts back words nobody vouched
 * for, so unknown; a person's own edit without one is theirs.
 */
export function organizationTitleOriginOf(
  change: Pick<OrganizationChange, 'origin' | 'executor' | 'undoOf'>
): OrganizationTitleOrigin {
  if (change.origin) {
    return change.origin
  }
  return isPersonExecutor(change.executor) && !change.undoOf ? 'yours' : 'unknown'
}

/** The history key of a target: its session key, else `folder:<id>`, `pane:<key>`, `tab:<id>`. */
export function organizationTargetKey(target: OrganizationTarget): string | null {
  if (target.sessionKey) {
    return target.sessionKey
  }
  if (target.folderId) {
    return `folder:${target.folderId}`
  }
  if (target.paneKey) {
    return `pane:${target.paneKey}`
  }
  return target.tabId ? `tab:${target.tabId}` : null
}

/** Launch filing's built-in reason: `filed at launch from request "<excerpt>"`. */
export function launchFilingReason(request?: string | null): string {
  const excerpt = sessionBatchRequestExcerpt(request ?? '')
  return excerpt ? `filed at launch from request "${excerpt}"` : 'filed at launch'
}
