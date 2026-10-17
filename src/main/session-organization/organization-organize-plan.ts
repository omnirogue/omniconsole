/**
 * Turns an organize plan into one change per kind (many targets each), against the sidebar as
 * main reads it: unknown panes, no-ops and changes that would hide a question are skipped with a
 * reason, and the five-line focus estimate is computed before and after.
 */

import {
  resolveSessionFolderRef,
  SAVED_SESSIONS_LABEL,
  SAVED_SESSIONS_REF_ID,
  sessionFolderRefSegments
} from '../../shared/session-folder-ref'
import type { SessionFolderEntry } from '../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageState } from '../../shared/session-manage-types'
import type {
  OrganizationChangeKind,
  OrganizationTarget,
  OrganizationTitleOrigin
} from '../../shared/session-organization-change'
import type {
  SessionOrganizeEntry,
  SessionOrganizeFolderReport,
  SessionOrganizePlan,
  SessionOrganizeSkip
} from '../../shared/session-organize'
import {
  estimateSessionFocusLines,
  type SessionFocusEstimate,
  type SessionFocusRow
} from '../../shared/session-organize-focus'

export type OrganizeRow = { row: SessionManageSidebarRow; state: SessionManageState }

/** One change to record: a kind, its targets and each target's value. */
export type OrganizeChangeGroup = {
  kind: OrganizationChangeKind
  origin?: OrganizationTitleOrigin
  targets: OrganizationTarget[]
  values: unknown[]
  panes: string[]
}

export type OrganizePlanned = {
  groups: OrganizeChangeGroup[]
  skipped: SessionOrganizeSkip[]
  folders: SessionOrganizeFolderReport[]
  /** Each planned session's current revision (`none` when never organized). */
  revisions: Map<string, string>
  focus: { before: SessionFocusEstimate; after: SessionFocusEstimate }
}

export const ORGANIZE_NO_REVISION = 'none'

export const ORGANIZE_ASKING_REFUSAL =
  'It is asking you something, so it stays in Needs you: it cannot be hidden or snoozed.'

const ASKING: ReadonlySet<SessionManageState> = new Set(['awaiting-user', 'waiting-for-yes'])

// Why this order: folders exist before moves, and archive goes last so the row is filed first.
const KIND_ORDER: OrganizationChangeKind[] = [
  'move',
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze',
  'archive',
  'unarchive',
  'title'
]

/** Refuses a plan that cannot be read one way; per-session problems are skipped instead. */
export function assertOrganizePlanShape(plan: SessionOrganizePlan): void {
  const seen = new Set<string>()
  for (const entry of plan.changes) {
    if (seen.has(entry.pane)) {
      throw new Error(`Pane ${entry.pane} appears twice in the plan; give each session one entry.`)
    }
    seen.add(entry.pane)
    if (entry.folder !== undefined && entry.unfile) {
      throw new Error(`Pane ${entry.pane}: pass folder or unfile, not both.`)
    }
    if (entry.title !== undefined && !entry.origin) {
      throw new Error(
        `Pane ${entry.pane}: a title needs origin "yours" (the person gave it) or "generated" (you wrote it).`
      )
    }
    const removed = new Set((entry.removeTags ?? []).map((tag) => tag.toLowerCase()))
    const both = (entry.addTags ?? []).find((tag) => removed.has(tag.toLowerCase()))
    if (both) {
      throw new Error(`Pane ${entry.pane}: tag "${both}" is both added and removed.`)
    }
  }
}

function samePath(entry: SessionFolderEntry, path: string): boolean {
  const wanted = sessionFolderRefSegments(path)
  const have = sessionFolderRefSegments(entry.path)
  return wanted.length === have.length && wanted.every((segment, index) => segment === have[index])
}

/** "OmniRogue / Checkout" as typed, normalized to the sidebar's own separator. */
function displayPath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' / ')
}

function planFolders(
  plan: SessionOrganizePlan,
  folders: readonly SessionFolderEntry[]
): SessionOrganizeFolderReport[] {
  return (plan.folders ?? []).map((folder) => {
    const path = displayPath(folder.create)
    return {
      path,
      status: folders.some((entry) => samePath(entry, path)) ? 'exists' : 'create',
      ...(folder.color !== undefined ? { color: folder.color } : {})
    }
  })
}

type Placement = { ok: true; id: string | null; path: string | null } | { ok: false; error: string }

function placementOf(
  entry: SessionOrganizeEntry,
  folders: readonly SessionFolderEntry[],
  planned: readonly SessionOrganizeFolderReport[]
): Placement | null {
  if (entry.unfile) {
    return { ok: true, id: null, path: null }
  }
  if (entry.folder === undefined) {
    return null
  }
  const resolved = resolveSessionFolderRef(folders, entry.folder)
  if (resolved.ok) {
    return resolved.target.kind === 'folder'
      ? { ok: true, id: resolved.target.folder.id, path: resolved.target.folder.path }
      : { ok: true, id: SAVED_SESSIONS_REF_ID, path: SAVED_SESSIONS_LABEL }
  }
  const created = planned.find(
    (folder) =>
      folder.status === 'create' &&
      sessionFolderRefSegments(folder.path).join('/') ===
        sessionFolderRefSegments(entry.folder!).join('/')
  )
  // Why no id: the folder is created when the plan applies; the window resolves its path then.
  return created ? { ok: true, id: '', path: created.path } : { ok: false, error: resolved.error }
}

function focusRow(organized: OrganizeRow): SessionFocusRow {
  const { row, state } = organized
  return {
    folder: row.folder,
    archived: row.archived,
    hidden: row.hidden === true,
    snoozed: Boolean(row.waitingUntil),
    state
  }
}

type Planner = {
  add: (
    kind: OrganizationChangeKind,
    row: OrganizeRow,
    value: unknown,
    origin?: OrganizationTitleOrigin
  ) => void
  skip: (pane: string, kind: SessionOrganizeSkip['kind'], reason: string) => void
}

function planEntry(
  entry: SessionOrganizeEntry,
  organized: OrganizeRow,
  context: {
    folders: readonly SessionFolderEntry[]
    planned: SessionOrganizeFolderReport[]
    now: number
  },
  planner: Planner,
  after: SessionFocusRow
): void {
  const { row, state } = organized
  const { pane } = entry
  const placement = placementOf(entry, context.folders, context.planned)
  if (placement && !placement.ok) {
    planner.skip(pane, 'move', placement.error)
  } else if (placement && placement.id !== '' && placement.id === row.folderId) {
    planner.skip(pane, 'move', `Already in ${row.folder ?? 'no folder'}.`)
  } else if (placement) {
    planner.add('move', organized, entry.unfile ? null : entry.folder)
    after.folder = placement.path
  }
  for (const tag of entry.addTags ?? []) {
    planner.add('tag', organized, tag)
  }
  for (const tag of entry.removeTags ?? []) {
    planner.add('untag', organized, tag)
  }
  const asking = ASKING.has(state) && !row.archived
  if (entry.hide !== undefined) {
    if (entry.hide && asking) {
      planner.skip(pane, 'hide', ORGANIZE_ASKING_REFUSAL)
    } else if (entry.hide === (row.hidden === true)) {
      planner.skip(
        pane,
        entry.hide ? 'hide' : 'unhide',
        entry.hide ? 'Already hidden.' : 'Not hidden.'
      )
    } else {
      planner.add(entry.hide ? 'hide' : 'unhide', organized, entry.hide)
      after.hidden = entry.hide
    }
  }
  if (entry.snooze !== undefined) {
    if (entry.snooze !== null && asking) {
      planner.skip(pane, 'snooze', ORGANIZE_ASKING_REFUSAL)
    } else if (entry.snooze === null && !row.waitingUntil) {
      planner.skip(pane, 'snooze', 'Not snoozed.')
    } else {
      planner.add('snooze', organized, entry.snooze)
      after.snoozed = entry.snooze !== null && entry.snooze > context.now
    }
  }
  if (entry.archive !== undefined) {
    if (entry.archive === row.archivedByHand) {
      planner.skip(
        pane,
        entry.archive ? 'archive' : 'unarchive',
        entry.archive ? 'Already archived.' : 'Not archived by hand.'
      )
    } else {
      planner.add(entry.archive ? 'archive' : 'unarchive', organized, entry.archive)
      after.archived = entry.archive
    }
  }
  if (entry.title !== undefined) {
    planner.add('title', organized, entry.title, entry.origin)
  }
}

export async function planOrganize(
  plan: SessionOrganizePlan,
  context: {
    rows: readonly OrganizeRow[]
    folders: readonly SessionFolderEntry[]
    /** The key's newest recorded revision (any field), or null when it has none. */
    revisionOf: (key: string) => Promise<string | null>
    now: number
  }
): Promise<OrganizePlanned> {
  assertOrganizePlanShape(plan)
  const folders = planFolders(plan, context.folders)
  const groups = new Map<string, OrganizeChangeGroup>()
  const skipped: SessionOrganizeSkip[] = []
  const revisions = new Map<string, string>()
  const byPane = new Map<string, OrganizeRow>()
  for (const organized of context.rows) {
    const pane = organized.row.paneKey
    if (pane && (!byPane.has(pane) || byPane.get(pane)!.row.folded)) {
      byPane.set(pane, organized)
    }
  }
  const afterRows = new Map(context.rows.map((organized) => [organized, focusRow(organized)]))
  const planner: Planner = {
    add: (kind, { row }, value, origin) => {
      const id = `${kind}:${origin ?? ''}`
      const group = groups.get(id) ?? {
        kind,
        ...(origin ? { origin } : {}),
        targets: [],
        values: [],
        panes: []
      }
      group.targets.push({
        sessionKey: row.viewKey,
        ...(row.paneKey ? { paneKey: row.paneKey } : {}),
        ...(row.tabId ? { tabId: row.tabId } : {})
      })
      group.values.push(value)
      if (!group.panes.includes(row.paneKey!)) {
        group.panes.push(row.paneKey!)
      }
      groups.set(id, group)
    },
    skip: (pane, kind, reason) => skipped.push({ pane, kind, reason })
  }
  for (const entry of plan.changes) {
    const organized = byPane.get(entry.pane)
    if (!organized) {
      planner.skip(entry.pane, 'entry', `No conversation in the sidebar has pane ${entry.pane}.`)
      continue
    }
    const revision = (await context.revisionOf(organized.row.viewKey)) ?? ORGANIZE_NO_REVISION
    if (entry.expectedRevision && entry.expectedRevision !== revision) {
      planner.skip(entry.pane, 'entry', `It was organized since the dry run (now ${revision}).`)
      continue
    }
    revisions.set(entry.pane, revision)
    planEntry(
      entry,
      organized,
      { folders: context.folders, planned: folders, now: context.now },
      planner,
      afterRows.get(organized)!
    )
  }
  return {
    groups: [...groups.values()].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    ),
    skipped,
    folders,
    revisions,
    focus: {
      before: estimateSessionFocusLines(
        context.rows.filter((organized) => !organized.row.folded).map(focusRow)
      ),
      after: estimateSessionFocusLines(
        context.rows
          .filter((organized) => !organized.row.folded)
          .map((organized) => afterRows.get(organized)!)
      )
    }
  }
}
