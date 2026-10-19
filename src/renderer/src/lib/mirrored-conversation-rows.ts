// Sidebar rows from paired owners' conversation ledgers (session parity, step 6). A tab-surface
// record joins the mirror row this window already built for the owner's pane; a record with no
// such row becomes a row of its own; a receiver capture of a conversation the owner lists folds
// into the owner's row. Owner equality (environment and workspace, F8) comes before any join or
// fold, and a ledger row never folds onto a row of this computer.

import {
  isMirroredConversationBucketLive,
  mirroredConversationTaggedIdentity,
  type MirroredConversationBucket,
  type MirroredConversationOwner
} from '@/store/slices/mirrored-conversation-ledger'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SessionArchiveProjection } from '../../../shared/session-archive-projection'
import {
  sessionConversationIdentityFromProviderKey,
  type RuntimeSessionConversationRecord,
  type SessionConversationArchiveMark,
  type SessionConversationLedgerFolder
} from '../../../shared/session-conversation-ledger'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { mirroredConversationLabel } from './mirrored-conversation-labels'
import {
  claimOwnerPanes,
  ownerPaneIndexKey,
  ownerPaneLeafId
} from './mirrored-conversation-pane-claims'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'
import type { sidebarSessionWorkspace } from './sidebar-session-context'
import type { SidebarSession, SidebarSessionSource } from './sidebar-session-types'

type WorkspaceContext = (
  worktreeId: string,
  hostId?: ExecutionHostId
) => ReturnType<typeof sidebarSessionWorkspace>

/** One ledger record, the bucket it came in and its owner's folder catalog by id. */
export type MirroredConversationEvidence = {
  bucket: MirroredConversationBucket
  record: RuntimeSessionConversationRecord
  folders: ReadonlyMap<string, SessionConversationLedgerFolder>
}

const NO_FOLDERS: ReadonlyMap<string, SessionConversationLedgerFolder> = new Map()

/** F21: a row the ledger creates is keyed by its owner, workspace and tagged identity. */
export function mirroredConversationRowKey(
  environmentId: string,
  worktreeId: string,
  record: Pick<RuntimeSessionConversationRecord, 'conversation' | 'paneIdentity'>
): string {
  return JSON.stringify([
    toRuntimeExecutionHostId(environmentId),
    'ledger',
    worktreeId,
    mirroredConversationTaggedIdentity(record)
  ])
}

/**
 * Addendum C3, the one owner-organization resolver for archive: the owner's explicit ledger mark
 * wins over its tab frame's (#1081) and, as `ownerArchive`, over both local stores in the tree,
 * management and project rows and the counts; an absent mark keeps the frame's (last known).
 */
export function resolveOwnerArchive(
  mark: SessionConversationArchiveMark | undefined,
  frame: SessionArchiveProjection | undefined
): SessionArchiveProjection | undefined {
  if (!mark) {
    return frame
  }
  // Why by hand when unsaid: a main-authored set says whether, not who, and the stack's frames
  // already read an owner's archive as the person's.
  return {
    archived: mark.archived,
    byHand: mark.archived && (mark.byHand ?? frame?.byHand ?? true)
  }
}

/**
 * The owner's word on a row. `word: 'presence'` (a joined row under a frozen bucket) carries the
 * identity, listing and state only: no rest, archive, folder or hidden flag, so the frame and the
 * local marks stand for them.
 */
function vouch(
  evidence: MirroredConversationEvidence,
  word: 'owner' | 'presence'
): MirroredSidebarConversation {
  const { bucket, record } = evidence
  const folder = record.folderId ? evidence.folders.get(record.folderId) : undefined
  const owner = word === 'owner'
  return {
    environmentId: bucket.environmentId,
    conversation: record.conversation,
    ...(record.paneIdentity ? { paneIdentity: record.paneIdentity } : {}),
    ownerPaneKey: record.paneKey ?? null,
    ownerTabId: record.tabId ?? null,
    rest: owner ? record.rest : 'unknown',
    ...(owner && record.archived ? { archivedByOwner: record.archived.archived } : {}),
    ...(owner && record.folderId !== undefined ? { folderIdByOwner: record.folderId } : {}),
    ...(owner && folder ? { folderByOwner: folder } : {}),
    ...(owner && record.hidden !== undefined ? { hidden: record.hidden } : {}),
    // Why any word: who launched a session never changes, so a frozen bucket still says it.
    ...(record.agentSession ? { agentSessionByOwner: true } : {}),
    listed: record.listed,
    stale: bucket.stale === true,
    ownerState: bucket.ownerState,
    ...(bucket.unverified ? { unverified: bucket.unverified } : {})
  }
}

/**
 * A row this window built for the owner's pane (or a capture of its conversation) with the owner's
 * word on it: rest, archive, folder, and the owner's title when the tab frame carried none and
 * nobody renamed the row here. The row keeps its frame key (F14). Only a live bucket's word
 * overrides the frame and the local marks; a frozen one (older owner, restored snapshot, history
 * gap) vouches for the row's presence and counts only, since the owner's frame may have moved
 * since (an archive on the owner after it turned older, C3's recency).
 */
export function joinLedgerToMirroredRow(
  row: SidebarSession,
  evidence: MirroredConversationEvidence,
  tab?: Pick<TerminalTab, 'runtimeOwnerTitleByLeafId'>
): SidebarSession {
  const { record } = evidence
  const live = isMirroredConversationBucketLive(evidence.bucket)
  const leafId = row.paneKey ? parsePaneKey(row.paneKey)?.leafId : undefined
  const framed = leafId ? tab?.runtimeOwnerTitleByLeafId?.[leafId] : undefined
  const titled =
    live && !row.customTitle && !framed && record.titleSource !== 'agent' && record.title.trim()
  const ownerArchive = live ? resolveOwnerArchive(record.archived, row.ownerArchive) : undefined
  return {
    ...row,
    ...(titled ? { label: record.title, labelSource: record.titleSource } : {}),
    ...(ownerArchive ? { ownerArchive } : {}),
    mirroredConversation: vouch(evidence, live ? 'owner' : 'presence')
  }
}

/** A row of the owner's own: on the mirror tab when one exists here, else tab- and pane-less. */
function ledgerRow(
  evidence: MirroredConversationEvidence,
  context: WorkspaceContext,
  mirrorTabId: string | null
): SidebarSession {
  const { bucket, record } = evidence
  const key = mirroredConversationRowKey(bucket.environmentId, bucket.worktreeId, record)
  const leafId = record.paneKey ? parsePaneKey(record.paneKey)?.leafId : undefined
  const ownerArchive = resolveOwnerArchive(record.archived, undefined)
  const provider = record.providerSession
  return {
    ...context(bucket.worktreeId, toRuntimeExecutionHostId(bucket.environmentId)),
    rowKey: key,
    sessionKey: key,
    worktreeId: bucket.worktreeId,
    // Why the mirror tab: a click opens the owner's pane this window already mirrors (a dormant
    // tab no row was built for). The owner's own pane lives only in mirroredConversation.
    tabId: mirrorTabId,
    paneKey: mirrorTabId && leafId ? makePaneKey(mirrorTabId, leafId) : null,
    kind: 'terminal',
    ...mirroredConversationLabel(record),
    agent: record.agent,
    ...(provider ? { providerSession: { key: provider.key, id: provider.id } } : {}),
    ...(ownerArchive ? { ownerArchive } : {}),
    folderKeyMigration: null,
    // Why the owner's full word: no frame of this window speaks for a row of the owner's own.
    mirroredConversation: vouch(evidence, 'owner')
  }
}

type OwnerRowIndex = { byPane: Map<string, number>; byConversation: Map<string, number[]> }

/** The digest of the row's own claim (F14), when its key names a conversation. */
function rowDigest(row: SidebarSession): string | null {
  return row.sessionKey
    ? (sessionConversationIdentityFromProviderKey(row.sessionKey)?.conversation ?? null)
    : null
}

/** Rows under paired runtimes, by pane and by conversation digest, each with its owner (F8). */
function indexOwnerRows(rows: readonly SidebarSession[]): OwnerRowIndex {
  const index: OwnerRowIndex = { byPane: new Map(), byConversation: new Map() }
  rows.forEach((row, position) => {
    if (!row.hostId?.startsWith('runtime:') || row.kind !== 'terminal' || row.mirroredWorkflow) {
      return
    }
    if (row.tabId) {
      const leafId = row.paneKey ? (parsePaneKey(row.paneKey)?.leafId ?? '') : ''
      index.byPane.set(ownerPaneIndexKey(row.hostId, row.worktreeId, row.tabId, leafId), position)
    }
    // Why the row's own key: it digests this computer's full local claim, path included (F14).
    const identity = row.sessionKey
      ? sessionConversationIdentityFromProviderKey(row.sessionKey)
      : null
    if (identity?.worktreeId === row.worktreeId) {
      const key = JSON.stringify([row.hostId, row.worktreeId, identity.conversation])
      index.byConversation.set(key, [...(index.byConversation.get(key) ?? []), position])
    }
  })
  return index
}

function folderCatalogs(
  owners: Readonly<Record<string, MirroredConversationOwner>> | undefined
): Map<string, ReadonlyMap<string, SessionConversationLedgerFolder>> {
  const catalogs = new Map<string, ReadonlyMap<string, SessionConversationLedgerFolder>>()
  for (const owner of Object.values(owners ?? {})) {
    catalogs.set(owner.environmentId, new Map(owner.folders.map((folder) => [folder.id, folder])))
  }
  return catalogs
}

function mirrorTab(
  state: SidebarSessionSource,
  worktreeId: string,
  tabId: string | null
): TerminalTab | undefined {
  // Why optional: a partial store double (or the store before hydration) has no tab map yet.
  return tabId ? state.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === tabId) : undefined
}

/**
 * Every sidebar row with the paired owners' ledgers applied. Listed records join or create rows
 * and fold this computer's captures of them; a `listed: false` record never becomes a row (G1),
 * it only vouches for a capture, which keeps its own row (step 8 counts it `heldByOwner`).
 */
export function mirroredConversationRows(
  rows: readonly SidebarSession[],
  state: SidebarSessionSource,
  context: WorkspaceContext
): SidebarSession[] {
  const buckets = Object.values(state.mirroredConversationLedgerByOwner ?? {})
  if (buckets.length === 0) {
    return [...rows]
  }
  const result: (SidebarSession | null)[] = [...rows]
  const index = indexOwnerRows(rows)
  const vouched = new Set<number>()
  const created: SidebarSession[] = []
  const catalogs = folderCatalogs(state.mirroredConversationOwnersByEnvironment)
  const decorate = (position: number, evidence: MirroredConversationEvidence): void => {
    const row = result[position]!
    result[position] = joinLedgerToMirroredRow(
      row,
      evidence,
      mirrorTab(state, row.worktreeId, row.tabId)
    )
    vouched.add(position)
  }
  // What the row this window built for an owner pane claims as its conversation, by pane key.
  const claimedDigest = (paneKey: string): string | null => {
    const position = index.byPane.get(paneKey)
    return position === undefined ? null : rowDigest(rows[position]!)
  }
  // Why listed records first: a held record only vouches for what no listed record claims.
  for (const listed of [true, false]) {
    for (const bucket of buckets) {
      const hostId = toRuntimeExecutionHostId(bucket.environmentId)
      const folders = catalogs.get(bucket.environmentId) ?? NO_FOLDERS
      // One owner pane, one row: which listed tab record takes each pane here.
      const claims = listed ? claimOwnerPanes(bucket, state, claimedDigest) : null
      for (const record of bucket.records) {
        if (record.listed !== listed) {
          continue
        }
        const evidence: MirroredConversationEvidence = { bucket, record, folders }
        const same = record.conversation
          ? (index.byConversation.get(
              JSON.stringify([hostId, bucket.worktreeId, record.conversation])
            ) ?? [])
          : []
        const open = same.filter((position) => result[position] && !vouched.has(position))
        if (!listed) {
          open.forEach((position) => decorate(position, evidence))
          continue
        }
        const tabId = claims?.get(record) ?? null
        const byPane = tabId
          ? index.byPane.get(
              ownerPaneIndexKey(hostId, bucket.worktreeId, tabId, ownerPaneLeafId(record))
            )
          : undefined
        const joined =
          byPane !== undefined && !vouched.has(byPane)
            ? byPane
            : open.find((position) => result[position]!.tabId !== null)
        if (joined === undefined) {
          const shown = mirrorTab(state, bucket.worktreeId, tabId) ? tabId : null
          created.push(ledgerRow(evidence, context, shown))
        } else {
          decorate(joined, evidence)
        }
        for (const position of open) {
          if (position === joined) {
            continue
          }
          // Why: this computer's own record of a conversation the owner lists folds into the
          // owner's row (ledger wins); another pane of it stays, vouched, so it stays addressable.
          if (result[position]!.tabId === null) {
            result[position] = null
            vouched.add(position)
          } else {
            decorate(position, evidence)
          }
        }
      }
    }
  }
  return [...result.filter((row): row is SidebarSession => row !== null), ...created]
}
