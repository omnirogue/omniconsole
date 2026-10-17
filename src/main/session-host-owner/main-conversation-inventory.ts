/**
 * The conversations this owner executes, as main reads them with no window (session parity,
 * step 3): existence and rest from the persisted LOCAL partition of the workspace session, with the
 * window's ownership classifier (addendum B2) and the runtime's connected PTYs as the only proof of
 * `live` (F16). The main-authored conversation ledger and the windowless host inventory (B3) both
 * read this one list, so they never disagree about which conversations exist.
 */

import type {
  AgentProviderSessionMetadata,
  SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  sessionConversationIdentity,
  sessionConversationPaneIdentity,
  type SessionConversationRest,
  type SessionConversationTitleSource
} from '../../shared/session-conversation-ledger'
import {
  paneSessionFolderKey,
  providerSessionFolderKey
} from '../../shared/session-folder-identity'
import {
  classifySessionInventoryTab,
  type SessionInventoryWorkspaceProvenance
} from '../../shared/session-inventory-ownership'
import { sessionOwnerTitle } from '../../shared/session-owner-title'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { classifyPersistedHeadlessTerminal } from '../runtime/mobile-session-inventory-ownership'

/** What the runtime hands the main-authored ledger (`readOwnerConversationInventory`). */
export type OwnerConversationInventorySource = {
  /** The persisted LOCAL partition, read explicitly: the catalog may resolve another host's. */
  session: WorkspaceSessionState
  /** The runtime's own workspace verdict, as every inventory path reads it. */
  provenance(worktreeId: string): SessionInventoryWorkspaceProvenance
  /** PTYs the runtime has connected now: a persisted pane mapping alone never proves `live`. */
  connectedPtys: readonly { ptyId: string; paneKey: string | null }[]
  /** The provider conversation the agent hooks last reported for a pane. */
  hookSession(
    paneKey: string
  ): { agent: string; providerSession: AgentProviderSessionMetadata } | null
}

export type MainInventoryConversation = {
  worktreeId: string
  /** The sidebar key its organization lives under: its provider key, else its pane key. */
  viewKey: string
  conversation: string | null
  paneIdentity: string
  agent: string
  providerSession: AgentProviderSessionMetadata | null
  surface: 'tab' | 'record'
  paneKey: string
  tabId: string | null
  rest: SessionConversationRest
  interrupted: boolean
  /** False for passive completed hibernation evidence the owner holds but does not list (G1). */
  listed: boolean
  /** The owner's own label when no window listed it: never a prompt (F2). */
  title: string
  titleSource: SessionConversationTitleSource
  updatedAt: number
  /** A persisted checkpoint resumes it. */
  resumable: boolean
}

/**
 * A workspace's verdict: how many of its rows were quarantined; its provenance kind (only an
 * `owned` one vouches for a row or proves an absence, as the window's rule says: addendum F3); and
 * whether it holds a direct-SSH record, which this owner's ledger never lists.
 */
export type MainInventoryWorkspace = {
  quarantined: number
  provenance: SessionInventoryWorkspaceProvenance['kind']
  connectionBound: boolean
}

export type MainConversationInventory = {
  conversations: MainInventoryConversation[]
  /** Every workspace the persisted partition holds evidence for. */
  workspaces: Map<string, MainInventoryWorkspace>
}

/** Mirrors the window's predicate (sleeping-agent-pane-ownership.ts): held, never listed. */
function isPassiveCompletedRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    record.origin !== 'quit' &&
    !(record.origin === 'live' && record.interrupted === true) &&
    record.state === 'done'
  )
}

/** Old structured projections saved their desktop id as if a terminal could resume it. */
function isStructuredSyntheticRecord(record: SleepingAgentSessionRecord): boolean {
  const pane = parsePaneKey(record.paneKey)
  return (
    pane !== null &&
    record.providerSession.key === 'session_id' &&
    structuredAgentSessionTabId(record.providerSession.id) === pane.tabId
  )
}

function recordTabId(record: SleepingAgentSessionRecord): string | null {
  return parsePaneKey(record.paneKey)?.tabId ?? record.tabId ?? null
}

/** The leaves the persisted layout names, as the runtime's headless hydration collects them. */
function persistedLeafIds(layout: TerminalLayoutSnapshot | undefined): string[] {
  const leafIds = new Set<string>()
  const visit = (node: TerminalLayoutSnapshot['root'] | undefined): void => {
    if (node?.type === 'leaf') {
      if (isTerminalLeafId(node.leafId)) {
        leafIds.add(node.leafId)
      }
    } else if (node) {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(layout?.root)
  for (const leafId of [layout?.activeLeafId, ...Object.keys(layout?.ptyIdsByLeafId ?? {})]) {
    if (leafId && isTerminalLeafId(leafId)) {
      leafIds.add(leafId)
    }
  }
  return [...leafIds]
}

// Why: the window names a "Terminal 3" title for its agent (isPlaceholderConversationTitle).
const PLACEHOLDER_TITLE = /^terminal \d+$/i

/**
 * The window's tab label order (sidebar-session-label.ts) as main can read it: the owner title,
 * then the record's terminal title, then the tab's — all but the live title only the window holds.
 * With none, or only a placeholder, the agent's name with `titleSource: 'agent'`, as the window
 * sends it: a receiver renders its own localized "<agent> (untitled)".
 */
function tabTitle(
  tab: TerminalTab,
  paneTitle: string | undefined,
  agent: string,
  recordTitle: string | undefined
): Pick<MainInventoryConversation, 'title' | 'titleSource'> {
  const named = sessionOwnerTitle(tab, paneTitle)
  const title = named ?? (recordTitle?.trim() || tab.title?.trim())
  if (!title || PLACEHOLDER_TITLE.test(title)) {
    return { title: agent, titleSource: 'agent' }
  }
  const titleSource: SessionConversationTitleSource = tab.customTitle?.trim()
    ? 'custom'
    : paneTitle?.trim()
      ? 'terminal'
      : named
        ? 'generated'
        : 'terminal'
  return { title, titleSource }
}

function identityOf(
  worktreeId: string,
  agent: string,
  providerSession: AgentProviderSessionMetadata | null,
  paneKey: string
) {
  return {
    viewKey: providerSession
      ? providerSessionFolderKey({
          hostId: LOCAL_EXECUTION_HOST_ID,
          worktreeId,
          agent,
          providerSession
        })
      : paneSessionFolderKey(LOCAL_EXECUTION_HOST_ID, worktreeId, paneKey),
    conversation: sessionConversationIdentity({ worktreeId, agent, providerSession }),
    paneIdentity: sessionConversationPaneIdentity(paneKey)
  }
}

export function mainConversationInventory(
  source: OwnerConversationInventorySource
): MainConversationInventory {
  const { session } = source
  const workspaces = new Map<string, MainInventoryWorkspace>()
  const workspace = (worktreeId: string, provenance: SessionInventoryWorkspaceProvenance) => {
    const known = workspaces.get(worktreeId) ?? {
      quarantined: 0,
      provenance: provenance.kind,
      connectionBound: false
    }
    workspaces.set(worktreeId, known)
    return known
  }
  const saved = Object.values(session.sleepingAgentSessionsByPaneKey ?? {})
  // Why: a record with a connection is an SSH host's conversation, never this owner's `local` row,
  // so its workspace proves no absence here (the window marks it incomplete the same way).
  const records = saved.filter(
    (record) => !record.connectionId && !isStructuredSyntheticRecord(record)
  )
  const connectionBound = new Set(
    saved.flatMap((record) => (record.connectionId ? [record.worktreeId] : []))
  )
  const connectedPtyIds = new Set(source.connectedPtys.map((pty) => pty.ptyId))
  const connectedPanes = new Set(source.connectedPtys.flatMap((pty) => pty.paneKey ?? []))
  // Why one per sidebar key, as the window lists it: tabs before records, a live pane over a
  // stopped one (a resumed conversation reports its latest pane, not its old record).
  const byViewKey = new Map<string, MainInventoryConversation>()
  const conversations = {
    push(conversation: MainInventoryConversation): void {
      const held = byViewKey.get(conversation.viewKey)
      if (!held || (conversation.rest === 'live' && held.rest !== 'live')) {
        byViewKey.set(conversation.viewKey, conversation)
      }
    }
  }
  const seenPanes = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    const provenance = source.provenance(worktreeId)
    const counts = workspace(worktreeId, provenance)
    for (const tab of tabs) {
      // Why: workflows ride their own carrier (workflowRecords), never this ledger.
      if (!isValidTerminalTabId(tab.id) || tab.localWorkflow || tab.conversationLaunchPending) {
        continue
      }
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const tabRecords = records.filter(
        (record) => recordTabId(record) === tab.id && record.worktreeId === worktreeId
      )
      const leafPanes = persistedLeafIds(layout).map((leafId) => makePaneKey(tab.id, leafId))
      const paneKeys = [...new Set([...leafPanes, ...tabRecords.map((record) => record.paneKey)])]
      const ownership = classifyPersistedHeadlessTerminal(
        provenance,
        tab,
        layout,
        session.unifiedTabs?.[worktreeId]
      )
      for (const paneKey of paneKeys) {
        const record = tabRecords.find((candidate) => candidate.paneKey === paneKey)
        const hook = source.hookSession(paneKey)
        const agent =
          hook?.agent ?? record?.agent ?? (paneKeys.length === 1 ? tab.launchAgent : null)
        if (!agent) {
          continue
        }
        seenPanes.add(paneKey)
        if (ownership.kind !== 'owned') {
          counts.quarantined += 1
          continue
        }
        const leafId = parsePaneKey(paneKey)?.leafId ?? ''
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (paneKeys.length === 1 ? tab.ptyId : null)
        const live = connectedPanes.has(paneKey) || (!!ptyId && connectedPtyIds.has(ptyId))
        const providerSession = hook?.providerSession ?? record?.providerSession ?? null
        conversations.push({
          worktreeId,
          ...identityOf(worktreeId, agent, providerSession, paneKey),
          agent,
          providerSession,
          surface: 'tab',
          paneKey,
          tabId: tab.id,
          rest: live ? 'live' : record ? 'asleep' : 'dormant',
          interrupted: record?.interrupted === true,
          listed: true,
          ...tabTitle(tab, layout?.titlesByLeafId?.[leafId], agent, record?.terminalTitle),
          updatedAt: Math.max(record?.updatedAt ?? 0, tab.createdAt ?? 0),
          resumable: Boolean(record)
        })
      }
    }
  }
  for (const record of records) {
    if (seenPanes.has(record.paneKey)) {
      continue
    }
    const provenance = source.provenance(record.worktreeId)
    const counts = workspace(record.worktreeId, provenance)
    const ownership = classifySessionInventoryTab(provenance, { tabId: recordTabId(record) })
    if (ownership.kind !== 'owned') {
      counts.quarantined += 1
      continue
    }
    const terminalTitle = record.terminalTitle?.trim()
    conversations.push({
      worktreeId: record.worktreeId,
      ...identityOf(record.worktreeId, record.agent, record.providerSession, record.paneKey),
      agent: record.agent,
      providerSession: record.providerSession,
      surface: 'record',
      paneKey: record.paneKey,
      tabId: null,
      rest: 'asleep',
      interrupted: record.interrupted === true,
      listed: !isPassiveCompletedRecord(record),
      // Why never the prompt: a record with no terminal title sends its agent's name (F2).
      ...(terminalTitle
        ? { title: terminalTitle, titleSource: 'terminal' as const }
        : { title: record.agent, titleSource: 'agent' as const }),
      updatedAt: record.updatedAt,
      resumable: true
    })
  }
  for (const worktreeId of connectionBound) {
    const known = workspaces.get(worktreeId)
    if (known) {
      known.connectionBound = true
    }
  }
  return { conversations: [...byViewKey.values()], workspaces }
}
