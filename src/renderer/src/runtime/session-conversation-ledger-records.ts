// The fields of this window's own conversation ledger (session parity, step 2): one record per
// conversation its population lists (session-conversation-ledger-eligibility.ts), with the owner's
// sidebar title and its source (addendum F2), the rest its PTY census proves (F16), its archive,
// folder, saved and hidden marks read by `conversationViewKey` (tri-state: explicit values only),
// the folder catalog the window keeps (never project settings), and per-workspace coverage. Nothing
// here reads a prompt, launch configuration, transcript path or assistant message into a record.

import type { AppState } from '@/store/types'
import type { SessionSidebarViewState } from '@/store/session-sidebar-view-state'
import { conversationViewKey, isPersonalRowHidden } from '@/lib/conversation-view'
import {
  getSessionFolderId,
  isSessionSaved,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import { isAgentLaunchedSession } from '@/lib/agent-session-note'
import { sessionArchiveKind } from '@/lib/session-manage-conversation-organization'
import { livePtyIdForSessionPane } from '@/lib/session-sleep-target'
import {
  sleepingRecordSessionLabel,
  type SidebarSessionLabelSource
} from '@/lib/sidebar-session-label'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  SESSION_CONVERSATION_LEDGER_LIMITS as LIMITS,
  sessionConversationPaneIdentity,
  sessionConversationRecordIdentity,
  type RuntimeSessionConversationRecord,
  type SessionConversationLedgerFolder,
  type SessionConversationLedgerProject,
  type SessionConversationLedgerWindowPublication,
  type SessionConversationRest
} from '../../../shared/session-conversation-ledger'
import { isProjectFolder } from '../../../shared/session-project-folder'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  conversationLedgerPopulation,
  type ConversationLedgerViewKeyed
} from './session-conversation-ledger-eligibility'

export type SessionConversationLedgerInputs = {
  /** The sidebar view store's marks: archive, deletion and hide (useSessionSidebarView). */
  view: Pick<SessionSidebarViewState, 'archived' | 'view'>
  /** This window's folder metadata (useSessionFolders); its project settings never cross. */
  metadata: SessionFolderMetadata
  /** PTY ids main reports alive now (live-pty-census.ts); null while that is unknown. */
  livePtyIds: ReadonlySet<string> | null
  /** The outcome chains the sidebar shows (session-chain-registry). */
  chains: readonly SessionChain[]
  rendererGeneration: string
  listedAt: number
}

type Marks = Pick<SessionConversationLedgerInputs, 'metadata'> & {
  view: SessionSidebarViewState['view']
  archived: readonly string[]
}
type OrganizationFields = Pick<
  RuntimeSessionConversationRecord,
  'archived' | 'folderId' | 'saved' | 'hidden' | 'agentSession'
>

/** The owner's own marks for one conversation, each explicit: `false` and `null` are answers too. */
function organization(marks: Marks, session: ConversationLedgerViewKeyed): OrganizationFields {
  const viewKey = conversationViewKey(session)
  // Why this rule: the archive kind the owner's own `omni session list` reports for the row.
  const kind = sessionArchiveKind(marks.view, marks.archived, viewKey)
  return {
    archived: kind ? { archived: true, byHand: kind === 'manual' } : { archived: false },
    folderId: getSessionFolderId(marks.metadata, viewKey),
    saved: isSessionSaved(marks.metadata, viewKey),
    hidden: isPersonalRowHidden(marks.view, session),
    ...(isAgentLaunchedSession(marks.metadata, viewKey) ? { agentSession: true as const } : {})
  }
}

/**
 * The owner's sidebar label and where it came from (F2), as #1081's `sessionTitle` carries it: a
 * rename, a pane or terminal title, or a generated title crosses as is. A label with no title of
 * its own — the agent's name, or a record's prompt the sidebar shows here — sends the agent's name
 * with `titleSource: 'agent'`. Why the bare name: a receiver renders its own localized
 * "<agent> (untitled)", so no prompt and no text in this computer's language crosses.
 */
function title(
  label: string,
  source: SidebarSessionLabelSource | undefined,
  agent: string
): Pick<RuntimeSessionConversationRecord, 'title' | 'titleSource'> {
  return source && source !== 'agent'
    ? { title: label.slice(0, LIMITS.title), titleSource: source }
    : { title: agent, titleSource: 'agent' }
}

/**
 * F16: live only when the pane's bound PTY is in main's census of PTYs alive now — never on the
 * window's pane→PTY maps alone, which a restart restores before any daemon answers. A bound PTY
 * whose liveness nobody could read is unknown; no live PTY with a sleeping record is asleep.
 */
function rest(
  state: AppState,
  session: SidebarSession,
  record: SleepingAgentSessionRecord | undefined,
  livePtyIds: ReadonlySet<string> | null
): SessionConversationRest {
  const pane = session.tabId && session.paneKey ? parsePaneKey(session.paneKey) : null
  const ptyId =
    pane && session.tabId ? livePtyIdForSessionPane(state, session.tabId, pane.leafId) : null
  if (ptyId) {
    if (livePtyIds === null) {
      return 'unknown'
    }
    if (livePtyIds.has(ptyId)) {
      return 'live'
    }
  }
  return record ? 'asleep' : 'dormant'
}

function rowRecord(
  state: AppState,
  marks: Marks,
  row: { session: SidebarSession; conversation: string | null } & Pick<
    RuntimeSessionConversationRecord,
    'providerSession'
  >,
  livePtyIds: ReadonlySet<string> | null
): RuntimeSessionConversationRecord {
  const { session } = row
  const record = session.paneKey
    ? state.sleepingAgentSessionsByPaneKey?.[session.paneKey]
    : undefined
  const tab = session.tabId
    ? state.tabsByWorktree?.[session.worktreeId]?.find((entry) => entry.id === session.tabId)
    : undefined
  const paneRest = rest(state, session, record, livePtyIds)
  return {
    conversation: row.conversation,
    ...(session.paneKey ? { paneIdentity: sessionConversationPaneIdentity(session.paneKey) } : {}),
    agent: session.agent,
    providerSession: row.providerSession,
    ...title(session.label, session.labelSource, session.agent),
    surface: session.tabId ? 'tab' : 'record',
    ...(session.paneKey ? { paneKey: session.paneKey } : {}),
    ...(session.tabId ? { tabId: session.tabId } : {}),
    rest: paneRest,
    ...(paneRest === 'asleep' && record?.interrupted ? { interrupted: true as const } : {}),
    ...organization(marks, session),
    listed: true,
    // Why: the newest change this window holds for it (a status ping is none); stable otherwise.
    updatedAt: Math.max(record?.updatedAt ?? 0, tab?.createdAt ?? 0)
  }
}

function heldRecord(
  marks: Marks,
  held: { record: SleepingAgentSessionRecord; session: ConversationLedgerViewKeyed },
  conversation: string
): RuntimeSessionConversationRecord {
  const { record } = held
  const label = sleepingRecordSessionLabel(record)
  return {
    conversation,
    paneIdentity: sessionConversationPaneIdentity(record.paneKey),
    agent: record.agent,
    providerSession: { key: record.providerSession.key, id: record.providerSession.id },
    ...title(label.label, label.labelSource, record.agent),
    surface: 'record',
    paneKey: record.paneKey,
    rest: 'asleep',
    ...(record.interrupted ? { interrupted: true as const } : {}),
    ...organization(marks, held.session),
    listed: false,
    updatedAt: record.updatedAt
  }
}

function folderCatalog(metadata: SessionFolderMetadata): {
  folders: SessionConversationLedgerFolder[]
  projects: SessionConversationLedgerProject[]
} {
  const folders = metadata.folders.slice(0, LIMITS.folders).map((folder) => ({
    id: folder.id,
    name: folder.name.slice(0, LIMITS.folderName),
    ...(folder.parentId ? { parentId: folder.parentId } : {}),
    ...(folder.section ? { section: folder.section } : {})
  }))
  // Why: which folders are projects, as the owner's Projects page lists them; never their settings.
  const projects = metadata.folders
    .filter((folder) => folder.section !== 'saved' && isProjectFolder(metadata.folders, folder.id))
    .slice(0, LIMITS.projects)
    .map((folder) => ({ folderId: folder.id }))
  return { folders, projects }
}

/**
 * This window's whole ledger publication. Coverage names every workspace the population speaks
 * for; one is complete only once this window restored its sessions and nothing in it was left
 * out, quarantined or cut at a cap.
 */
export function buildSessionConversationLedger(
  state: AppState,
  inputs: SessionConversationLedgerInputs
): SessionConversationLedgerWindowPublication {
  const population = conversationLedgerPopulation(state, inputs.view.view, inputs.chains)
  const marks: Marks = {
    view: inputs.view.view,
    archived: [...new Set([...inputs.view.archived, ...(inputs.view.view.archived ?? [])])],
    metadata: inputs.metadata
  }
  const buckets = new Map<string, RuntimeSessionConversationRecord[]>()
  const omitted = { unknownHost: 0, unverified: 0 }
  // Why counted, not dropped: a workspace id past the wire bound cannot cross, and no reader may
  // see the owner's total shrink with no reason.
  const fits = (worktreeId: string): boolean => worktreeId.length <= LIMITS.worktreeId
  const add = (worktreeId: string, record: RuntimeSessionConversationRecord): void => {
    if (fits(worktreeId)) {
      buckets.set(worktreeId, [...(buckets.get(worktreeId) ?? []), record])
    } else {
      omitted.unverified += 1
    }
  }
  for (const row of population.rows) {
    if (row.publish) {
      add(row.session.worktreeId, rowRecord(state, marks, row, inputs.livePtyIds))
    } else if (row.reason === 'unknown-host') {
      omitted.unknownHost += 1
    } else {
      omitted.unverified += 1
    }
  }
  for (const held of population.held) {
    add(held.record.worktreeId, heldRecord(marks, held, held.conversation))
  }
  const recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]> = {}
  const truncated: string[] = []
  let total = 0
  for (const worktreeId of [...buckets.keys()].sort()) {
    // Why sorted: a reorder of tabs is no change to the set.
    const records = buckets
      .get(worktreeId)!
      .sort((a, b) =>
        sessionConversationRecordIdentity(a).localeCompare(sessionConversationRecordIdentity(b))
      )
    const room = Math.max(0, Math.min(LIMITS.recordsPerWorkspace, LIMITS.totalRecords - total))
    if (records.length > room) {
      truncated.push(worktreeId)
    }
    total += Math.min(records.length, room)
    if (room > 0) {
      recordsByWorktree[worktreeId] = records.slice(0, room)
    }
  }
  // Why: before this window restored its sessions (or after a degraded start) absence is unknown.
  const restored =
    state.hydrationSucceeded === true && state.terminalStartupRestorationReady === true
  const coverage = [...population.workspaces]
    .filter(fits)
    .sort()
    .slice(0, LIMITS.workspaces)
    .map((worktreeId) => ({
      worktreeId,
      complete:
        restored && !population.incomplete.has(worktreeId) && !truncated.includes(worktreeId)
    }))
  return {
    rendererGeneration: inputs.rendererGeneration,
    listedAt: inputs.listedAt,
    coverage,
    omitted,
    ...(truncated.length > 0 ? { truncatedWorktrees: truncated } : {}),
    ...folderCatalog(inputs.metadata),
    recordsByWorktree
  }
}
