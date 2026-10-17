import { translate } from '@/i18n/i18n'
import { parseAskFromStatus } from '../../../shared/native-chat-ask'
import { sessionQuestionSummary } from '../../../shared/session-questions'
import { compareAttentionPanes } from '@/components/attention/agent-pane-snapshot'
import type { ConversationFleetSidebarRow } from './conversation-fleet-sidebar'
import {
  emptySessionFolderTally,
  sessionFolderRowState,
  type SessionFolderTally
} from './session-folder-rollup'
import type { SessionFolder } from './session-folders'
import {
  isSessionLensGroupKind,
  type SessionSidebarGroup,
  type SessionSidebarLensGroupKind,
  type SessionSidebarTreeRow
} from './session-sidebar-group-model'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import { fleetRowNeedsPerson } from './session-focus-asks'
import {
  rankSessionFocusEntries,
  SESSION_FOCUS_UNFILED_BUCKET,
  type SessionFocusRank
} from '../../../shared/session-focus-ranking'

export { SESSION_FOCUS_LINE_LIMIT } from '../../../shared/session-focus-ranking'
/** The expanded Needs you list's group key; the focus view owns its open state, not the tree. */
export const SESSION_FOCUS_NEEDS_YOU_KEY = 'focus:needs-you'
/** A wait ending within this counts as "waiting soon"; a later one is snoozed and never counts. */
export const SESSION_FOCUS_WAITING_SOON_MS = 60 * 60 * 1000

export type SessionFocusFolderRank = SessionFocusRank

export type SessionFocusFolderLine = {
  /** The folder's group key, or `unfiled` for the pseudo-folder of unfiled sessions. */
  key: string
  label: string
  /** Null for Unfiled and for a Group-by view's group. */
  folder: SessionFolder | null
  /** Set when the line is a Group-by view's group rather than a folder. */
  lens?: SessionSidebarLensGroupKind
  tally: SessionFolderTally
  rank: SessionFocusFolderRank
}

export type SessionFocusNeedsYou = {
  /** Most urgent first: the attention ranking (oldest wait first), then plan and returned rows. */
  rows: SessionSidebarTreeRow[]
  /** Fleet runs waiting on the person, after the rows. */
  fleetRows: ConversationFleetSidebarRow[]
}

export type SessionFocusLines = {
  needsYou: SessionFocusNeedsYou | null
  folders: SessionFocusFolderLine[]
  /** What the lines above leave out; always one line, the way into the full tree. */
  everythingElse: { sessions: number; folders: number }
  /** Under a Group-by view the lines are its groups, and Everything else counts groups. */
  byLens?: boolean
}

type FocusGroup = Pick<
  SessionSidebarGroup,
  'key' | 'kind' | 'label' | 'folder' | 'rows' | 'hidden' | 'folderTally' | 'nestedRows'
> & { fleetRows?: readonly ConversationFleetSidebarRow[] }

type Bucket = {
  key: string
  label: string
  folder: SessionFolder | null
  tally: SessionFolderTally | undefined
  order: number
  rankable: boolean
  lens?: SessionSidebarLensGroupKind
  own: SessionFolderTally
}

/** Under a Group-by view each of its groups is a line, and Needs you never earns a second one. */
function lensBucketInit(
  group: FocusGroup,
  order: number,
  byLens: boolean
): Omit<Bucket, 'own'> | null {
  if (isSessionLensGroupKind(group.kind)) {
    const { key, label, folderTally: tally, kind: lens } = group
    return { key, label, folder: null, tally, order, rankable: true, lens }
  }
  if (byLens && group.kind === 'attention') {
    const key = SESSION_FOCUS_NEEDS_YOU_KEY
    return { key, label: group.label, folder: null, tally: undefined, order, rankable: false }
  }
  return null
}

function waitMs(row: SessionSidebarTreeRow): number | null {
  const at = row.waitingUntil ? Date.parse(row.waitingUntil) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/**
 * The focus view's lines from the sidebar's groups: one Needs you line, up to three folders
 * that matter now (four when nothing needs you), and Everything else. Hidden, snoozed and
 * archived sessions never count, except toward Needs you when they ask (`putAwayAsks`, and fleet
 * runs in any group).
 */
export function buildSessionFocusLines(
  groups: readonly FocusGroup[],
  now: number,
  putAwayAsks: readonly SessionSidebarTreeRow[] = []
): SessionFocusLines {
  const activeFolders = new Map<string, FocusGroup>()
  for (const group of groups) {
    if (group.kind === 'folder' && group.folder && !group.hidden) {
      activeFolders.set(group.folder.id, group)
    }
  }
  const rootOf = (folderId: string): string => {
    let id = folderId
    const seen = new Set<string>()
    for (;;) {
      const parent = activeFolders.get(id)?.folder?.parentId
      // Why the guard: a looped parent link must not spin forever.
      if (!parent || !activeFolders.has(parent) || seen.has(parent)) {
        return id
      }
      seen.add(id)
      id = parent
    }
  }
  const buckets = new Map<string, Bucket>()
  const bucketFor = (key: string, init: () => Omit<Bucket, 'own'>): Bucket => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { ...init(), own: emptySessionFolderTally() }
      buckets.set(key, bucket)
    }
    return bucket
  }
  const byLens = groups.some((group) => isSessionLensGroupKind(group.kind))
  const seen = new Set<string>()
  const counted: {
    row: SessionSidebarTreeRow
    bucket: Bucket
    needsYou: boolean
    rank: SessionFocusRank | null
  }[] = []
  const fleetAsks = new Map<string, ConversationFleetSidebarRow>()
  groups.forEach((group, order) => {
    for (const fleet of group.fleetRows ?? []) {
      if (fleetRowNeedsPerson(fleet)) {
        fleetAsks.set(fleet.run.workflowId, fleet)
      }
    }
    // Why workers: an agent's workers count on the session that launched them, never on their own.
    if (
      group.hidden ||
      group.kind === 'archived' ||
      group.kind === 'hidden' ||
      group.kind === 'workers'
    ) {
      return
    }
    // Why nested rows: a folded folder's subfolders are not groups of their own, but still count.
    const folderGroup = group.kind === 'folder' && group.folder ? group : null
    for (const row of folderGroup ? [...group.rows, ...(group.nestedRows ?? [])] : group.rows) {
      if (row.archived || row.workerOf || seen.has(row.session.rowKey)) {
        continue
      }
      seen.add(row.session.rowKey)
      const wait = waitMs(row)
      if (wait !== null && wait > now + SESSION_FOCUS_WAITING_SOON_MS && !rowNeedsPerson(row)) {
        continue
      }
      const state = sessionFolderRowState(row, group.kind === 'completed' ? 'completed' : undefined)
      const needsYou = rowNeedsPerson(row) || state === 'needsYou'
      const folderId = folderGroup
        ? rootOf(folderGroup.folder!.id)
        : row.folderId && activeFolders.has(row.folderId)
          ? rootOf(row.folderId)
          : null
      const lensBucket = lensBucketInit(group, order, byLens)
      const bucket = lensBucket
        ? bucketFor(lensBucket.key, () => lensBucket)
        : folderId
          ? bucketFor(folderId, () => {
              const root = activeFolders.get(folderId)!
              return {
                key: root.key,
                label: root.label,
                folder: root.folder ?? null,
                tally: root.folderTally,
                order: groups.indexOf(root),
                rankable: true
              }
            })
          : row.folderId
            ? // Why: a session filed in a saved folder counts toward Everything else, never for a line.
              bucketFor(`saved:${row.folderId}`, () => ({
                key: `saved:${row.folderId}`,
                label: group.label,
                folder: group.folder ?? null,
                tally: undefined,
                order,
                rankable: false
              }))
            : bucketFor(SESSION_FOCUS_UNFILED_BUCKET, () => ({
                key: SESSION_FOCUS_UNFILED_BUCKET,
                label: translate('conversations.focus.unfiled', 'Unfiled'),
                folder: null,
                tally: undefined,
                order: Number.MAX_SAFE_INTEGER,
                rankable: true
              }))
      const tallyState = needsYou ? 'needsYou' : state
      if (tallyState) {
        bucket.own[tallyState] += 1
      }
      bucket.own.total += 1
      counted.push({
        row,
        bucket,
        needsYou,
        rank: state === 'working' ? 'working' : state === 'waiting' ? 'waitingSoon' : null
      })
    }
  })
  const putAway = putAwayAsks.filter((row) => !seen.has(row.session.rowKey))
  const needsYouRows = [
    ...counted.filter((entry) => entry.needsYou).map((entry) => entry.row),
    ...putAway
  ]
  const fleetRows = [...fleetAsks.values()]
  const asksElsewhere = Array.from({ length: putAway.length + fleetRows.length }, () => ({
    bucket: SESSION_FOCUS_UNFILED_BUCKET,
    rankable: false,
    order: Number.MAX_SAFE_INTEGER,
    needsYou: true,
    rank: null
  }))
  const ranking = rankSessionFocusEntries([
    ...counted.map(({ bucket, needsYou, rank }) => ({
      bucket: bucket.key,
      rankable: bucket.rankable,
      order: bucket.order,
      needsYou,
      rank
    })),
    ...asksElsewhere
  ])
  const byKey = new Map([...buckets.values()].map((bucket) => [bucket.key, bucket]))
  return {
    needsYou:
      needsYouRows.length + fleetRows.length > 0
        ? { rows: mostUrgentFirst(needsYouRows), fleetRows }
        : null,
    folders: ranking.folders.map(({ bucket: key, rank }) => {
      const bucket = byKey.get(key)!
      return {
        key: bucket.key,
        label: bucket.label,
        folder: bucket.folder,
        ...(bucket.lens ? { lens: bucket.lens } : {}),
        // Why the folder's own tally: it is the one its heading shows in the full tree.
        tally: bucket.tally?.total ? bucket.tally : bucket.own,
        rank
      }
    }),
    everythingElse: ranking.everythingElse,
    byLens
  }
}

function mostUrgentFirst(rows: SessionSidebarTreeRow[]): SessionSidebarTreeRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.attention && b.row.attention) {
        return compareAttentionPanes(a.row.attention, b.row.attention) || a.index - b.index
      }
      return (a.row.attention ? 0 : 1) - (b.row.attention ? 0 : 1) || a.index - b.index
    })
    .map(({ row }) => row)
}

/** The question a Needs you line shows inline: the run's ask, the pane's ask, else its title. */
export function sessionFocusQuestion(row: SessionSidebarTreeRow): string {
  const ask = parseAskFromStatus(row.attention?.askSummary)
  // Why parse: askSummary is the agent's raw question JSON, never text to show as is.
  return (
    row.attention?.run?.headline ||
    (ask && ask.questions.length > 0 ? sessionQuestionSummary(ask) : '') ||
    row.attention?.askSummary ||
    row.session.label
  )
}

export function sessionFocusNeedsYouCount(needsYou: SessionFocusNeedsYou): number {
  return needsYou.rows.length + needsYou.fleetRows.length
}

/** The Needs you line's most urgent question: the first row's, else the first fleet run's title. */
export function sessionFocusTopQuestion(needsYou: SessionFocusNeedsYou): string {
  const top = needsYou.rows[0]
  return top ? sessionFocusQuestion(top) : (needsYou.fleetRows[0]?.run.title ?? '')
}

/** How many lines the focus view draws for these lines. */
export function sessionFocusLineCount(lines: SessionFocusLines): number {
  return (lines.needsYou ? 1 : 0) + lines.folders.length + 1
}
