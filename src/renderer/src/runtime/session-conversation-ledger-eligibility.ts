// Which conversations this window's own ledger lists (session parity, step 2; addendum B1, F3, F7,
// graft G1). The population is the owner's EFFECTIVE sidebar membership: the rows
// `buildSidebarSessions` builds from exactly the slices the visible sidebar reads, minus the rows the
// person deleted (the same marks and predicate session-sidebar-tree.ts applies), under `local` or
// under no host at all, terminal conversations only (workflow anchors ride their own carrier). A row
// is published only when the shared per-tab/record classifier (session-inventory-ownership.ts) says
// this computer owns it AND its workspace is owned here; every other row is quarantined with its
// reason — still listed here, never published as this computer's, counted so no total shrinks, and
// its workspace never reads complete. Step 8 builds the owner's own counts from this same rule.

import type { AppState } from '@/store/types'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { isSessionRowDeleted } from '@/lib/conversation-view'
import { getShownChains } from '@/lib/session-chain-registry'
import { getSessionInventoryWorkspaceProvenance } from '@/lib/session-inventory-workspace-provenance'
import { getSessionOwnershipUnverifiedReason } from '@/lib/session-ownership-verdict'
import type { SessionSidebarView } from '@/lib/session-sidebar-view'
import { sidebarWorkspaceContexts } from '@/lib/sidebar-session-context'
import { selectSidebarSessionStatus } from '@/lib/sidebar-session-status-projection'
import {
  buildSidebarSessions,
  type SidebarSession,
  type SidebarSessionSource
} from '@/lib/sidebar-sessions'
import { isPassiveCompletedHibernationEvidence } from '@/lib/sleeping-agent-pane-ownership'
import { isStructuredAgentSyntheticSleepingRecord } from '@/lib/structured-agent-synthetic-sleeping-record'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  sessionConversationIdentity,
  sessionConversationIdentityFromProviderKey,
  type SessionConversationProviderSession
} from '../../../shared/session-conversation-ledger'
import { providerSessionFolderKey } from '../../../shared/session-folder-identity'
import { memoizedConversationLedgerEligibility } from './session-conversation-ledger-eligibility-memo'
import {
  classifySessionInventoryTab,
  type SessionInventoryTabOwnership,
  type SessionInventoryWorkspaceProvenance
} from '../../../shared/session-inventory-ownership'
import type { SessionOwnershipUnverifiedReason } from '../../../shared/session-manage-relay'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

export type ConversationLedgerQuarantineReason =
  /** No execution host this computer can name for its workspace. */
  | 'unknown-host'
  /** Neither a provider conversation nor a pane yet: a launch still in flight. */
  | 'no-identity'
  /** Its tab or record carries a paired computer's evidence, or its workspace is a peer's. */
  | 'peer-provenance'
  | SessionOwnershipUnverifiedReason

/** The ledger's eligibility rule over this window's sidebar rows, keyed by sidebar row key. */
export type ConversationLedgerEligibility = {
  /** Rows the ledger lists: the owner's own `ownerListed` population. */
  published: Set<string>
  /** Rows the owner lists under `local` (or under no host) that the ledger cannot vouch for. */
  quarantined: Map<string, ConversationLedgerQuarantineReason>
}

export type ConversationLedgerVerdict =
  | {
      publish: true
      conversation: string | null
      providerSession: SessionConversationProviderSession | null
    }
  | { publish: false; reason: ConversationLedgerQuarantineReason }

export type ConversationLedgerRowVerdict = { session: SidebarSession } & ConversationLedgerVerdict

/** The keys a row's organization marks are read by (`conversationViewKey`), and its tab. */
export type ConversationLedgerViewKeyed = Pick<SidebarSession, 'tabId' | 'sessionKey' | 'rowKey'>

/** Passive completed-hibernation evidence the owner holds with no tab: listed:false (G1). */
export type ConversationLedgerHeldRecord = {
  record: SleepingAgentSessionRecord
  session: ConversationLedgerViewKeyed
  conversation: string
}

export type ConversationLedgerPopulation = {
  rows: ConversationLedgerRowVerdict[]
  held: ConversationLedgerHeldRecord[]
  /** Every workspace the ledger speaks for: this computer's local ones and any a row names. */
  workspaces: Set<string>
  /** Workspaces that cannot read complete now, whatever else holds. */
  incomplete: Set<string>
}

/** The slices the visible sidebar builds its rows from (use-sidebar-sessions.ts), nothing else. */
function sidebarSource(state: AppState): SidebarSessionSource {
  return {
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    sshConnectionStates: state.sshConnectionStates,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    // Why: status pings move no row; the projection keeps every row-shaping field.
    agentStatusByPaneKey: selectSidebarSessionStatus(state.agentStatusByPaneKey ?? {}),
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    pendingStartupByTabId: state.pendingStartupByTabId,
    automaticAgentResumeClaimsByTabId: state.automaticAgentResumeClaimsByTabId,
    localWorkflowStatusByTabId: state.localWorkflowStatusByTabId,
    localWorkflowHydrationByTabId: state.localWorkflowHydrationByTabId,
    buildReview: state.buildReview,
    mirroredWorkflowRecordsByOwner: state.mirroredWorkflowRecordsByOwner
  }
}

/** The tab's own provenance, as the desktop publication reads it (mobile-session-publication-ownership). */
function rowOwnership(
  state: AppState,
  session: SidebarSession,
  workspace: SessionInventoryWorkspaceProvenance
): SessionInventoryTabOwnership {
  if (!session.tabId) {
    // Why: a tab-less record's pane is its only provenance; a web-terminal pane is a peer's.
    const record = session.paneKey ? state.sleepingAgentSessionsByPaneKey?.[session.paneKey] : null
    const paneTabId = session.paneKey ? parsePaneKey(session.paneKey)?.tabId : null
    return classifySessionInventoryTab(workspace, { tabId: record?.tabId ?? paneTabId })
  }
  const tab = state.tabsByWorktree?.[session.worktreeId]?.find((row) => row.id === session.tabId)
  const layout = state.terminalLayoutsByTabId?.[session.tabId]
  const unified = state.unifiedTabsByWorktree?.[session.worktreeId]?.find(
    (row) => row.contentType === 'terminal' && row.entityId === session.tabId
  )
  return classifySessionInventoryTab(workspace, {
    tabId: session.tabId,
    executionHostId: unified?.executionHostId,
    ptyIds: [tab?.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})]
  })
}

function rowVerdict(
  state: AppState,
  session: SidebarSession,
  workspace: SessionInventoryWorkspaceProvenance
): ConversationLedgerVerdict {
  // Why the row's own key: it names the conversation exactly as this sidebar keys it, including an
  // identity a live entry carries through a turn that dropped its resume metadata (C5).
  const conversation = session.sessionKey
    ? (sessionConversationIdentityFromProviderKey(session.sessionKey)?.conversation ?? null)
    : null
  if (!conversation && !session.paneKey) {
    return { publish: false, reason: 'no-identity' }
  }
  const ownership = rowOwnership(state, session, workspace)
  const reason =
    ownership.kind === 'peer'
      ? 'peer-provenance'
      : ownership.kind === 'unverified'
        ? ownership.reason
        : workspace.kind === 'peer'
          ? 'peer-provenance'
          : workspace.kind === 'unresolved'
            ? 'unresolved-workspace'
            : // Why last: a null reason is no ownership evidence (it is null for a verified peer row
              // too); it only adds the absence doubts the sidebar labels.
              getSessionOwnershipUnverifiedReason(state, session)
  if (reason) {
    return { publish: false, reason }
  }
  const provider = session.providerSession
  return {
    publish: true,
    conversation,
    providerSession: provider ? { key: provider.key, id: provider.id } : null
  }
}

/**
 * The ledger's population: every sidebar row it judges, the passive evidence it lists apart, and
 * the workspaces it covers. `view` supplies the deletion marks; `chains` the outcome chains the
 * sidebar shows (they decide which panes have rows).
 */
export function conversationLedgerPopulation(
  state: AppState,
  view: Pick<SessionSidebarView, 'deleted'>,
  chains: readonly SessionChain[]
): ConversationLedgerPopulation {
  const source = sidebarSource(state)
  const context = sidebarWorkspaceContexts(source)
  const deleted = new Set(view.deleted ?? [])
  const provenanceByWorktree = new Map<string, SessionInventoryWorkspaceProvenance>()
  const provenance = (worktreeId: string): SessionInventoryWorkspaceProvenance => {
    let found = provenanceByWorktree.get(worktreeId)
    if (!found) {
      found = getSessionInventoryWorkspaceProvenance(state, worktreeId)
      provenanceByWorktree.set(worktreeId, found)
    }
    return found
  }
  const population: ConversationLedgerPopulation = {
    rows: [],
    held: [],
    workspaces: new Set(),
    incomplete: new Set()
  }
  for (const session of buildSidebarSessions(source, chains)) {
    if (
      session.kind !== 'terminal' ||
      session.workflow ||
      session.mirroredWorkflow ||
      isSessionRowDeleted(deleted, session)
    ) {
      continue
    }
    if (session.hostId === null) {
      population.rows.push({ session, publish: false, reason: 'unknown-host' })
    } else if (session.hostId === 'local') {
      population.rows.push({
        session,
        ...rowVerdict(state, session, provenance(session.worktreeId))
      })
    } else if (parseExecutionHostId(session.hostId)?.kind === 'ssh') {
      // Why: a direct-SSH pane in a local workspace is this computer's but not this ledger's, so
      // that workspace never proves an absence. A paired computer's mirror is its owner's to list.
      population.incomplete.add(session.worktreeId)
    }
  }
  for (const row of population.rows) {
    population.workspaces.add(row.session.worktreeId)
    if (!row.publish) {
      population.incomplete.add(row.session.worktreeId)
    }
  }
  addHeldRecords(state, population, { context, deleted, provenance })
  for (const worktreeId of localWorkspaceCandidates(state)) {
    if (context(worktreeId).hostId === 'local') {
      population.workspaces.add(worktreeId)
    }
  }
  for (const worktreeId of population.workspaces) {
    // Why (F3): a workspace more than one computer is recorded on cannot prove what is absent.
    if (provenance(worktreeId).kind !== 'owned') {
      population.incomplete.add(worktreeId)
    }
  }
  return population
}

/** Workspaces this window knows: the catalog's worktrees and folders, and any it holds sessions in. */
function localWorkspaceCandidates(state: AppState): Set<string> {
  return new Set([
    ...Object.values(state.worktreesByRepo ?? {}).flatMap((rows) => rows.map((row) => row.id)),
    ...(state.folderWorkspaces ?? []).map((folder) => folderWorkspaceKey(folder.id)),
    ...Object.keys(state.tabsByWorktree ?? {}),
    ...Object.values(state.sleepingAgentSessionsByPaneKey ?? {}).map((record) => record.worktreeId)
  ])
}

/**
 * G1: completed hibernation evidence the sidebar does not list (sidebar-sessions skips it) and no
 * tab of this window shows. Listed apart (`listed: false`) so a paired computer's own capture of
 * that conversation folds onto it instead of being retired; evidence that cannot be verified as
 * this computer's is left out and keeps its workspace incomplete.
 */
function addHeldRecords(
  state: AppState,
  population: ConversationLedgerPopulation,
  lookup: {
    context: ReturnType<typeof sidebarWorkspaceContexts>
    deleted: ReadonlySet<string>
    provenance: (worktreeId: string) => SessionInventoryWorkspaceProvenance
  }
): void {
  const key = (worktreeId: string, conversation: string): string => `${worktreeId}\0${conversation}`
  const listed = new Set(
    population.rows.flatMap((row) =>
      row.publish && row.conversation ? [key(row.session.worktreeId, row.conversation)] : []
    )
  )
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
    const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
    if (
      !isPassiveCompletedHibernationEvidence(record) ||
      isStructuredAgentSyntheticSleepingRecord(record) ||
      (tabId && state.tabsByWorktree?.[record.worktreeId]?.some((tab) => tab.id === tabId))
    ) {
      continue
    }
    const host = lookup.context(
      record.worktreeId,
      record.connectionId ? toSshExecutionHostId(record.connectionId) : undefined
    ).hostId
    if (host !== 'local') {
      if (host === null) {
        population.incomplete.add(record.worktreeId)
      }
      continue
    }
    const session = {
      tabId: null,
      sessionKey: providerSessionFolderKey({ ...record, hostId: host }),
      rowKey: JSON.stringify([host, record.paneKey])
    }
    const conversation = sessionConversationIdentity(record)
    if (
      !conversation ||
      isSessionRowDeleted(lookup.deleted, session) ||
      listed.has(key(record.worktreeId, conversation))
    ) {
      continue
    }
    const workspace = lookup.provenance(record.worktreeId)
    if (
      workspace.kind !== 'owned' ||
      classifySessionInventoryTab(workspace, { tabId }).kind !== 'owned'
    ) {
      population.incomplete.add(record.worktreeId)
      continue
    }
    listed.add(key(record.worktreeId, conversation))
    population.workspaces.add(record.worktreeId)
    population.held.push({ record, session, conversation })
  }
}

/**
 * F7: the ledger's eligibility rule as a selector, so the owner's own counts (step 8) and its
 * publication are built by one rule. Defaults read the sidebar's deletion marks and shown chains.
 * Memoised by input identity (session-conversation-ledger-eligibility-memo.ts): every reader
 * after a sidebar change shares one build.
 */
export function selectConversationLedgerEligibility(
  state: AppState,
  view: Pick<SessionSidebarView, 'deleted'> = useSessionSidebarView.getState().view,
  chains: readonly SessionChain[] = getShownChains()
): ConversationLedgerEligibility {
  return memoizedConversationLedgerEligibility(state, view, chains, () => {
    const eligibility: ConversationLedgerEligibility = {
      published: new Set(),
      quarantined: new Map()
    }
    for (const row of conversationLedgerPopulation(state, view, chains).rows) {
      if (row.publish) {
        eligibility.published.add(row.session.rowKey)
      } else {
        eligibility.quarantined.set(row.session.rowKey, row.reason)
      }
    }
    return eligibility
  })
}
