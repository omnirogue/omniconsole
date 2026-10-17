import {
  firstSessionLabel,
  sleepingRecordSessionLabel,
  terminalPaneSessionLabel
} from './sidebar-session-label'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { tabVaultProviderSession } from './sidebar-vault-session'
import { isValidHostTerminalTabId, isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '@/components/terminal-pane/terminal-layout-leaf-ids'
import {
  paneSessionFolderKey,
  providerSessionFolderKey,
  structuredSessionFolderKey
} from './session-folder-identity'
import { sidebarWorkspaceContexts } from './sidebar-session-context'
import { isStructuredAgentSyntheticSleepingRecord } from './structured-agent-synthetic-sleeping-record'
import { isPassiveCompletedHibernationEvidence } from './sleeping-agent-pane-ownership'
import type { SessionChain } from '../../../shared/session-chain-types'
import { indexSidebarOutcomeSources } from './sidebar-outcome-sources'
import { workflowSidebarRowFields } from './local-workflow-tab-status'
import { indexPaneRecordsByTab, shouldReplaceSidebarSession } from './sidebar-session-owner'
import { mirroredWorkflowRows } from './mirrored-workflow-rows'
import { mirroredConversationRows } from './mirrored-conversation-rows'
import type { SidebarSession, SidebarSessionSource } from './sidebar-session-types'

// Why re-exported: the row types moved beside the ledger row types (max-lines); importers stay.
export type { SidebarSession, SidebarSessionSource } from './sidebar-session-types'

// A projection of existing open/restorable sessions; no rows are persisted here.
// `state` is read straight off `useAppStore.getState()` at call sites outside React
// (e.g. `conversationSourceForPane`), so a caller under test with a partial store
// double — or the real store before its slices hydrate — can hand us a state whose
// pane-keyed maps are absent. The contract (`SidebarSessionSource`) allows this: an
// unloaded slice means "no rows from it yet", never a crash.
export function buildSidebarSessions(
  state: SidebarSessionSource,
  outcomeChains: readonly SessionChain[] = []
): SidebarSession[] {
  return buildSessionRows(state, outcomeChains, true)
}

/** Pane actions retain every owner, even when another tab resumes the same provider session. */
export function buildPaneSessions(
  state: SidebarSessionSource,
  outcomeChains: readonly SessionChain[] = []
): SidebarSession[] {
  return buildSessionRows(state, outcomeChains, false)
}

function buildSessionRows(
  state: SidebarSessionSource,
  outcomeChains: readonly SessionChain[],
  deduplicateProviderSessions: boolean
): SidebarSession[] {
  const outcomeSources = indexSidebarOutcomeSources(outcomeChains)
  const rows = new Map<string, SidebarSession>()
  const seenPanes = new Set<string>()
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree ?? {}
  const tabsByWorktree = state.tabsByWorktree ?? {}
  const terminalLayoutsByTabId = state.terminalLayoutsByTabId ?? {}
  const pendingStartupByTabId = state.pendingStartupByTabId ?? {}
  const automaticAgentResumeClaimsByTabId = state.automaticAgentResumeClaimsByTabId ?? {}
  const sleepingAgentSessionsByPaneKey = state.sleepingAgentSessionsByPaneKey ?? {}
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? {}
  const recordsByTab = indexPaneRecordsByTab(sleepingAgentSessionsByPaneKey)
  const entriesByTab = indexPaneRecordsByTab(agentStatusByPaneKey)
  const workspaceContext = sidebarWorkspaceContexts(state)
  const add = (row: SidebarSession): void => {
    const key = deduplicateProviderSessions ? (row.sessionKey ?? row.rowKey) : row.rowKey
    if (shouldReplaceSidebarSession(rows.get(key), row, agentStatusByPaneKey)) {
      rows.set(key, row)
    }
  }
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType !== 'agent-session') {
        continue
      }
      const context = workspaceContext(worktreeId, tab.executionHostId)
      add({
        ...context,
        rowKey: JSON.stringify([context.hostId, tab.id]),
        sessionKey: context.hostId
          ? structuredSessionFolderKey(context.hostId, tab.entityId)
          : null,
        worktreeId,
        tabId: tab.id,
        paneKey: null,
        kind: 'structured',
        structuredSessionId: tab.entityId,
        ...firstSessionLabel([
          [tab.customLabel, 'custom'],
          [tab.generatedLabel, 'generated'],
          [tab.label, 'terminal']
        ]),
        ...(tab.customLabel?.trim() ? { customTitle: tab.customLabel } : {}),
        agent: tab.agentSessionAgent ?? 'Agent',
        folderKeyMigration: null
      })
    }
  }

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      if (!isValidTerminalTabId(tab.id)) {
        continue
      }
      const unified = unifiedTabsByWorktree[worktreeId]?.find(
        (item) => item.entityId === tab.id && item.contentType === 'terminal'
      )
      const context = workspaceContext(worktreeId, unified?.executionHostId)
      // Why host ids only: a web-terminal mirror id names a peer's tab, never this window's run.
      const ownWorkflow = tab.localWorkflow && isValidHostTerminalTabId(tab.id)
      if (tab.conversationLaunchPending || ownWorkflow) {
        add({
          ...workflowSidebarRowFields(tab, state),
          ...context,
          // Why (step 9): a workflow is grouped and counted under its controller, this computer,
          // as a paired computer counts it; identity and archive keys still name the workspace host.
          ...(ownWorkflow ? { displayHostId: 'local' as const } : {}),
          rowKey: JSON.stringify([context.hostId, worktreeId, tab.id]),
          sessionKey: null,
          worktreeId,
          tabId: tab.id,
          paneKey: null,
          kind: 'terminal',
          ...firstSessionLabel([
            [tab.customTitle, 'custom'],
            [tab.title, 'terminal']
          ]),
          ...(tab.customTitle?.trim() ? { customTitle: tab.customTitle } : {}),
          folderKeyMigration: null
        })
        continue
      }
      const layout = terminalLayoutsByTabId[tab.id]
      const leaves = collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId)
      const rootless = layout ? resolveRootlessTerminalLayoutLeafId(layout) : null
      const leafIds = leaves.length ? leaves : rootless ? [rootless] : []
      const paneKeys = leafIds.map((leaf) => makePaneKey(tab.id, leaf))
      const records = (recordsByTab.get(tab.id) ?? []).filter(
        (record) => record.worktreeId === worktreeId
      )
      const entries = (entriesByTab.get(tab.id) ?? []).filter(
        (entry) =>
          (!entry.worktreeId || entry.worktreeId === worktreeId) &&
          entry.terminalResumeEligible !== false
      )
      const keys = new Set([
        ...paneKeys,
        ...records.map((record) => record.paneKey),
        ...entries.map((entry) => entry.paneKey)
      ])
      if (!keys.size && tab.launchAgent) {
        keys.add('')
      }
      for (const paneKey of keys) {
        const entry = entries.find((item) => item.paneKey === paneKey)
        const record = records.find((item) => item.paneKey === paneKey)
        const connectionId =
          entry?.connectionId === undefined ? record?.connectionId : entry.connectionId
        const paneContext = connectionId
          ? workspaceContext(
              worktreeId,
              unified?.executionHostId ?? toSshExecutionHostId(connectionId)
            )
          : context
        const startup = pendingStartupByTabId[tab.id]
        const claim = automaticAgentResumeClaimsByTabId[tab.id]
        const vaultSession = tabVaultProviderSession(tab, paneKeys, paneKey)
        const providerAgent =
          entry?.agentType ??
          record?.agent ??
          (keys.size === 1 ? (tab.launchAgent ?? vaultSession?.agent) : undefined)
        const rowKey = JSON.stringify([paneContext.hostId, worktreeId, paneKey || tab.id])
        // The provider can exit while its saved work continues. Retain only an
        // existing, exactly owned source pane; never infer that an agent is live.
        const savedOutcome = paneKeys.some((key) => key === paneKey)
          ? outcomeSources.get(rowKey)
          : undefined
        if (!providerAgent && savedOutcome === undefined) {
          continue
        }
        const agent = providerAgent ?? 'Agent'
        // A new live entry without identity must not borrow an older session from this pane.
        const providerSession: AgentProviderSessionMetadata | undefined = entry
          ? entry.providerSession
          : (record?.providerSession ??
            (keys.size === 1
              ? (claim?.providerSession ??
                startup?.resumeProviderSession ??
                vaultSession?.providerSession)
              : undefined))
        // Why (C5): the row is keyed by its conversation, which a live entry keeps for its process
        // incarnation even while a new turn has dropped the resume metadata.
        const conversationSession = providerSession ?? entry?.conversationIdentity?.providerSession
        const providerKey =
          conversationSession && paneContext.hostId
            ? providerSessionFolderKey({
                hostId: paneContext.hostId,
                worktreeId,
                agent,
                providerSession: conversationSession
              })
            : null
        // Why: a real pane (non-empty paneKey) has a stable identity of its own
        // — hostId + worktreeId + tabId:leafId — the moment it exists, even
        // before any agent reports a provider session. This is what lets a
        // terminal-hosted Claude chat be filed into a folder immediately; see
        // paneSessionFolderKey and the migration note on SidebarSession.
        const provisionalKey =
          paneKey && paneContext.hostId
            ? paneSessionFolderKey(paneContext.hostId, worktreeId, paneKey)
            : null
        const sessionKey = providerKey ?? provisionalKey
        // Why reported metadata only: a carried identity never takes this pane's filing (C5).
        const folderKeyMigration =
          providerSession && providerKey && provisionalKey && providerKey !== provisionalKey
            ? { from: provisionalKey, to: providerKey }
            : null
        if (paneKey) {
          seenPanes.add(paneKey)
        }
        add({
          ...paneContext,
          rowKey,
          sessionKey,
          worktreeId,
          tabId: tab.id,
          paneKey: paneKey || null,
          ...(paneContext.hostId?.startsWith('runtime:') &&
          paneKey &&
          tab.runtimeOwnerArchiveByLeafId?.[parsePaneKey(paneKey)?.leafId ?? '']
            ? { ownerArchive: tab.runtimeOwnerArchiveByLeafId[parsePaneKey(paneKey)!.leafId] }
            : {}),
          kind: 'terminal',
          providerSession,
          agent,
          ...terminalPaneSessionLabel({
            tab,
            layout,
            paneKey,
            agent,
            entryTitle: entry?.terminalTitle,
            recordTitle: record?.terminalTitle,
            outcome: !providerAgent && savedOutcome ? savedOutcome : undefined
          }),
          ...(tab.customTitle?.trim() ? { customTitle: tab.customTitle } : {}),
          folderKeyMigration
        })
      }
    }
  }

  for (const record of Object.values(sleepingAgentSessionsByPaneKey)) {
    if (
      seenPanes.has(record.paneKey) ||
      isStructuredAgentSyntheticSleepingRecord(record) ||
      isPassiveCompletedHibernationEvidence(record)
    ) {
      continue
    }
    const context = workspaceContext(
      record.worktreeId,
      record.connectionId ? toSshExecutionHostId(record.connectionId) : undefined
    )
    add({
      ...context,
      rowKey: JSON.stringify([context.hostId, record.paneKey]),
      sessionKey: context.hostId
        ? providerSessionFolderKey({ ...record, hostId: context.hostId })
        : null,
      worktreeId: record.worktreeId,
      tabId: null,
      paneKey: record.paneKey,
      kind: 'terminal',
      providerSession: record.providerSession,
      agent: record.agent,
      ...sleepingRecordSessionLabel(record),
      folderKeyMigration: null
    })
  }
  mirroredWorkflowRows(state.mirroredWorkflowRecordsByOwner, workspaceContext).forEach(add)
  // Why after every other row: ledger records join the mirror rows already built (step 6).
  return mirroredConversationRows([...rows.values()], state, workspaceContext)
}
