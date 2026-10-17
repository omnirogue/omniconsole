import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import {
  classifySessionInventoryTab,
  classifySessionInventoryWorkspaceRecords,
  type SessionInventoryTabOwnership,
  type SessionInventoryWorkspaceProvenance
} from '../../shared/session-inventory-ownership'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { Tab } from '../../shared/tab-types'

/**
 * The runtime's workspace verdict, with the desktop's records predicate and input order: a host
 * recorded on the workspace (worktree meta, or the folder record behind its partition) wins;
 * otherwise every repo record sharing its repo id, or the partition host when the catalog cannot
 * report repos. A local record shadowing a paired one is unresolved (positive local evidence
 * only) rather than silently local; missing metadata is never foreign evidence.
 */
export function classifyRuntimeSessionInventoryWorkspace(records: {
  workspaceHostIds: readonly (ExecutionHostId | null | undefined)[]
  repoHostIds: readonly (ExecutionHostId | null | undefined)[]
}): SessionInventoryWorkspaceProvenance {
  return classifySessionInventoryWorkspaceRecords(records)
}

type RepoCatalog = {
  getRepos?: () => readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[] | undefined
}
const repoHostIndexByCatalog = new WeakMap<RepoCatalog, Map<string, ExecutionHostId[]>>()

/** Every execution host the catalog records for `repoId`, read once per synchronous pass. */
export function getRuntimeCatalogRepoHostIds(
  catalog: RepoCatalog | null | undefined,
  repoId: string
): ExecutionHostId[] {
  if (!catalog?.getRepos) {
    return []
  }
  let index = repoHostIndexByCatalog.get(catalog)
  if (!index) {
    const next = new Map<string, ExecutionHostId[]>()
    // Why: a store that cannot report repos gives no conflict evidence, never "no repos".
    for (const repo of catalog.getRepos() ?? []) {
      next.set(repo.id, [...(next.get(repo.id) ?? []), getRepoExecutionHostId(repo)])
    }
    index = next
    repoHostIndexByCatalog.set(catalog, index)
    // Why: listAll and fan-out emits walk every workspace; one hydrated catalog read serves the
    // whole pass, and the next pass sees any repo change.
    queueMicrotask(() => repoHostIndexByCatalog.delete(catalog))
  }
  return index.get(repoId) ?? []
}

/**
 * Keep only surfaces this runtime's local/controller inventory owns. Every runtime inventory path
 * (list, listAll and both subscriptions) answers through here, so a renderer, headless or
 * restored row backed by a paired runtime's PTY or web mirror is never republished as ours, and
 * a quarantined row (conflicting stamp, or no evidence in an unresolved workspace) stays in this
 * runtime's inventory without being republished. Returns the same object when nothing is dropped.
 */
export function filterOwnedMobileSessionSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  workspace: SessionInventoryWorkspaceProvenance,
  unifiedTabs?: readonly Pick<Tab, 'contentType' | 'entityId' | 'executionHostId'>[]
): RuntimeMobileSessionTabsSnapshot {
  const tabs = snapshot.tabs.filter(
    (tab) =>
      tab.type !== 'terminal' ||
      classifySessionInventoryTab(workspace, {
        tabId: tab.parentTabId,
        executionHostId: unifiedTabs?.find(
          (unified) => unified.contentType === 'terminal' && unified.entityId === tab.parentTabId
        )?.executionHostId,
        ptyIds: [tab.ptyId]
      }).kind === 'owned'
  )
  if (tabs.length === snapshot.tabs.length) {
    return snapshot
  }
  const kept = new Set(tabs.map((tab) => tab.id))
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      kept.add(tab.parentTabId)
    }
  }
  const activeKept = snapshot.activeTabId !== null && kept.has(snapshot.activeTabId)
  return {
    ...snapshot,
    activeTabId: activeKept ? snapshot.activeTabId : null,
    activeTabType: activeKept ? snapshot.activeTabType : null,
    ...(snapshot.tabGroups
      ? {
          tabGroups: snapshot.tabGroups.map((group) => ({
            ...group,
            tabOrder: group.tabOrder.filter((id) => kept.has(id)),
            activeTabId:
              group.activeTabId && kept.has(group.activeTabId) ? group.activeTabId : null,
            ...(group.recentTabIds
              ? { recentTabIds: group.recentTabIds.filter((id) => kept.has(id)) }
              : {})
          }))
        }
      : {}),
    tabs
  }
}

/**
 * Headless hydration's view of one persisted terminal: the persisted unified tab's execution
 * host, the tab's PTY and its layout leaves are the same per-tab provenance the desktop uses.
 * Why not just a boolean: a quarantined row stays in the headless inventory (visible here, as the
 * desktop keeps it visible with a can't-verify caption); only a peer's mirror is left out.
 */
export function classifyPersistedHeadlessTerminal(
  workspace: SessionInventoryWorkspaceProvenance,
  tab: Pick<TerminalTab, 'id' | 'ptyId'>,
  layout: Pick<TerminalLayoutSnapshot, 'ptyIdsByLeafId'> | undefined,
  unifiedTabs: readonly Pick<Tab, 'contentType' | 'entityId' | 'executionHostId'>[] | undefined
): SessionInventoryTabOwnership {
  const unified = unifiedTabs?.find(
    (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
  )
  return classifySessionInventoryTab(workspace, {
    tabId: tab.id,
    executionHostId: unified?.executionHostId,
    ptyIds: [tab.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})]
  })
}
