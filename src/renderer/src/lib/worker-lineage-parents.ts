import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkerLineageActionIdentity, WorkerLineageLink } from '../../../shared/worker-lineage'
import { paneLeafIdentity } from './session-sidebar-worker-rows'

/**
 * Why: a coordinator may dispatch to a session the person had already started; that session stays
 * theirs. A worker's tab is opened for the work, so it is no older than this before its first task.
 */
export const WORKER_TAB_LEAD_MS = 30 * 60_000

type ResolvedWorkerLink = { leaf: string; link: WorkerLineageLink }

/**
 * Worker pane leaf → launcher pane leaf. A worker on a paired runtime is found by its terminal
 * handle among the mirrored panes (their pty ids carry the environment and handle).
 */
function resolveWorkerLinks(args: {
  links: readonly WorkerLineageLink[]
  terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>
  tabsByWorktree: Readonly<Record<string, readonly Pick<TerminalTab, 'id' | 'createdAt'>[]>>
}): ResolvedWorkerLink[] {
  const leafByRemoteTerminal = new Map<string, string>()
  const tabIdByLeaf = new Map<string, string>()
  for (const [tabId, layout] of Object.entries(args.terminalLayoutsByTabId)) {
    for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
      tabIdByLeaf.set(leafId, tabId)
      const remote = parseRemoteRuntimePtyId(ptyId)
      if (remote?.environmentId) {
        leafByRemoteTerminal.set(`${remote.environmentId}\n${remote.handle}`, leafId)
      }
    }
  }
  const createdAtByTabId = new Map<string, number>()
  for (const tabs of Object.values(args.tabsByWorktree)) {
    for (const tab of tabs) {
      createdAtByTabId.set(tab.id, tab.createdAt)
    }
  }
  const resolved: ResolvedWorkerLink[] = []
  const seenLeaves = new Set<string>()
  for (const link of args.links) {
    // A recorded foreign/legacy parent key is not enough to confer worker display identity.
    if (!parsePaneKey(link.parentPaneKey)) {
      continue
    }
    const leaf =
      link.child.kind === 'pane'
        ? parsePaneKey(link.child.paneKey)?.leafId
        : leafByRemoteTerminal.get(`${link.child.environmentId}\n${link.child.terminal}`)
    if (!leaf || seenLeaves.has(leaf)) {
      continue
    }
    const tabId =
      tabIdByLeaf.get(leaf) ??
      (link.child.kind === 'pane' ? parsePaneKey(link.child.paneKey)?.tabId : undefined)
    const createdAt = tabId ? createdAtByTabId.get(tabId) : undefined
    if (createdAt !== undefined && link.dispatchedAt - createdAt > WORKER_TAB_LEAD_MS) {
      continue
    }
    seenLeaves.add(leaf)
    resolved.push({ leaf, link })
  }
  return resolved
}

export function resolveWorkerParentLeaves(
  args: Parameters<typeof resolveWorkerLinks>[0]
): Map<string, string> {
  const parents = new Map<string, string>()
  for (const { leaf, link } of resolveWorkerLinks(args)) {
    if (!link.retainedByUser) {
      parents.set(leaf, paneLeafIdentity(link.parentPaneKey))
    }
  }
  return parents
}

/** Fresh lineage only: remembered grouping must never keep the SUB role alive by itself. */
export function resolveWorkerSubagentLeaves(
  args: Parameters<typeof resolveWorkerLinks>[0]
): Set<string> {
  return new Set(
    resolveWorkerLinks(args)
      .filter(({ link }) => !link.retainedByUser)
      .map(({ leaf }) => leaf)
  )
}

/** Fresh dispatch identity for exact worker actions; unlike parents, this is never remembered. */
export function resolveWorkerDispatchIds(
  args: Parameters<typeof resolveWorkerLinks>[0]
): Map<string, WorkerLineageActionIdentity> {
  return new Map(
    resolveWorkerLinks(args)
      .filter(
        ({ link }) =>
          !link.retainedByUser &&
          typeof link.dispatchId === 'string' &&
          typeof link.processIncarnation === 'string' &&
          link.child.kind === 'pane'
      )
      .map(({ leaf, link }) => [
        leaf,
        { dispatchId: link.dispatchId!, processIncarnation: link.processIncarnation! }
      ])
  )
}

/** Leaves whose durable lineage says the person already took or retained ownership. */
export function resolveUserRetainedWorkerLeaves(
  args: Parameters<typeof resolveWorkerLinks>[0]
): Set<string> {
  return new Set(
    resolveWorkerLinks(args)
      .filter(({ link }) => link.retainedByUser)
      .map(({ leaf }) => leaf)
  )
}

const REMEMBERED_KEY = 'omni.sessionWorkerParents.v1'
const REMEMBERED_LIMIT = 2000

/**
 * Worker leaf → launcher leaf as the sidebar last resolved it. Why remembered: a paired runtime's
 * worker is matched by its live terminal handle; once it exits the handle is gone, and the worker
 * must stay under its launcher all the same.
 */
export function readRememberedWorkerParents(): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? '{}')
    return new Map(
      parsed && typeof parsed === 'object'
        ? Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        : []
    )
  } catch {
    return new Map()
  }
}

export function saveRememberedWorkerParents(parents: ReadonlyMap<string, string>): void {
  try {
    const kept = [...parents].slice(-REMEMBERED_LIMIT)
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // A convenience only: without it an exited remote worker is listed on its own again.
  }
}
