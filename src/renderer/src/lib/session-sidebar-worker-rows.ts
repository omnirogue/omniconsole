import { isLiveSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { planSeatRows } from './session-sidebar-seat-state'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import type { WorkerLineageActionIdentity } from '../../../shared/worker-lineage'

/** A pane's remint-stable identity: its leaf UUID (the tab half changes on break-out). */
export function paneLeafIdentity(paneKey: string): string {
  return parsePaneKey(paneKey)?.leafId ?? paneKey
}

const MAX_LINEAGE_DEPTH = 32

export type NestedWorkerRows<T extends SessionSidebarTreeRow> = {
  /** The list without the nested workers; each launcher carries `workers`. */
  rows: T[]
  /** A launcher's workers by the launcher's row key. */
  workersByRowKey: Map<string, T[]>
  /** Workers whose launcher is not in the list: they go to the Agent sessions group. */
  orphanRowKeys: Set<string>
}

/** A worker stays where it is when the person filed it, archived it, or it asks for them. */
function canNest(row: SessionSidebarTreeRow): boolean {
  return !row.archived && row.folderId === null && !rowNeedsPerson(row)
}

function isRunning(row: SessionSidebarTreeRow): boolean {
  return row.pursuitState === 'working' || row.pursuitState === 'running'
}

/**
 * Why (Sal, 2026-09-21): "THE PURPOSE IS TO MINIMIZE DISTRACTIONS" — sessions another session
 * dispatched as workers are counted on that session and listed only when it is expanded.
 * `workerParentByLeaf` maps a worker pane's leaf to its launcher's (orchestration.workerLineage);
 * a finished plan's seats are its workers too (a live plan nests them itself).
 */
export function nestWorkerRows<T extends SessionSidebarTreeRow>(
  rows: readonly T[],
  args: {
    workerParentByLeaf?: ReadonlyMap<string, string>
    workerDispatchByLeaf?: ReadonlyMap<string, WorkerLineageActionIdentity>
    workerSubagentLeaves?: ReadonlySet<string>
    chainByRowKey?: ReadonlyMap<string, SessionChain>
    isExpanded?: (row: T) => boolean
  }
): NestedWorkerRows<T> {
  const workersByRowKey = new Map<string, T[]>()
  const orphanRowKeys = new Set<string>()
  const subagentRows = new Set<string>()
  const dispatchByRowKey = new Map<string, WorkerLineageActionIdentity>()
  // undefined: not a worker; null: a worker whose launcher is not listed.
  const parentOf = new Map<string, T | null>()
  const lineage = args.workerParentByLeaf
  if (lineage?.size) {
    const byLeaf = new Map<string, T>()
    for (const row of rows) {
      if (row.session.paneKey) {
        byLeaf.set(paneLeafIdentity(row.session.paneKey), row)
      }
    }
    for (const row of rows) {
      const actionIdentity = row.session.paneKey
        ? args.workerDispatchByLeaf?.get(paneLeafIdentity(row.session.paneKey))
        : undefined
      if (actionIdentity) {
        dispatchByRowKey.set(row.session.rowKey, actionIdentity)
      }
      const parentLeaf = row.session.paneKey
        ? lineage.get(paneLeafIdentity(row.session.paneKey))
        : undefined
      if (parentLeaf !== undefined) {
        parentOf.set(row.session.rowKey, byLeaf.get(parentLeaf) ?? null)
        const leaf = row.session.paneKey ? paneLeafIdentity(row.session.paneKey) : ''
        if (args.workerSubagentLeaves?.has(leaf) ?? true) {
          subagentRows.add(row.session.rowKey)
        }
      }
    }
  }
  for (const parent of rows) {
    const chain = args.chainByRowKey?.get(parent.session.rowKey)
    if (!chain?.outcomeSet || isLiveSessionChain(chain)) {
      continue
    }
    for (const seat of planSeatRows(rows, parent, chain)) {
      if (!parentOf.has(seat.session.rowKey)) {
        parentOf.set(seat.session.rowKey, parent)
      }
    }
  }
  if (parentOf.size === 0) {
    return { rows: [...rows], workersByRowKey, orphanRowKeys }
  }
  // The nearest launcher that stays listed; null on a loop.
  const topOf = (row: T): T | null => {
    const seen = new Set([row.session.rowKey])
    let current = parentOf.get(row.session.rowKey)
    while (current) {
      if (seen.has(current.session.rowKey) || seen.size > MAX_LINEAGE_DEPTH) {
        return null
      }
      seen.add(current.session.rowKey)
      const next = canNest(current) ? parentOf.get(current.session.rowKey) : undefined
      if (!next) {
        return current
      }
      current = next
    }
    return null
  }
  const nested = new Set<string>()
  for (const row of rows) {
    const key = row.session.rowKey
    if (!parentOf.has(key) || !canNest(row)) {
      continue
    }
    const top = topOf(row)
    if (top) {
      const workers = workersByRowKey.get(top.session.rowKey) ?? []
      workers.push(row)
      workersByRowKey.set(top.session.rowKey, workers)
      nested.add(key)
    } else if (parentOf.get(key) === null) {
      orphanRowKeys.add(key)
    }
  }
  return {
    rows: rows
      .filter((row) => !nested.has(row.session.rowKey))
      .map((row) => {
        const workers = workersByRowKey.get(row.session.rowKey)
        const subagent = subagentRows.has(row.session.rowKey)
        const workerIdentity = dispatchByRowKey.get(row.session.rowKey)
        if (!workers && !subagent && !workerIdentity) {
          return row
        }
        return {
          ...row,
          ...(subagent ? { subagent: true } : {}),
          ...(workerIdentity
            ? {
                workerDispatchId: workerIdentity.dispatchId,
                workerProcessIncarnation: workerIdentity.processIncarnation
              }
            : {}),
          ...(workers
            ? {
                workers: {
                  count: workers.length,
                  running: workers.filter(isRunning).length,
                  expanded: args.isExpanded?.(row) ?? false
                }
              }
            : {})
        }
      }),
    workersByRowKey: new Map(
      [...workersByRowKey].map(([key, workers]) => [
        key,
        workers.map((worker) =>
          subagentRows.has(worker.session.rowKey) || dispatchByRowKey.has(worker.session.rowKey)
            ? {
                ...worker,
                ...(subagentRows.has(worker.session.rowKey) ? { subagent: true } : {}),
                ...(dispatchByRowKey.get(worker.session.rowKey)
                  ? {
                      workerDispatchId: dispatchByRowKey.get(worker.session.rowKey)!.dispatchId,
                      workerProcessIncarnation: dispatchByRowKey.get(worker.session.rowKey)!
                        .processIncarnation
                    }
                  : {})
              }
            : worker
        )
      ])
    ),
    orphanRowKeys
  }
}

/**
 * The list with each expanded launcher's workers right under it, in its group; while searching,
 * every worker is listed on its own so a search finds it.
 */
export function listWorkerRows<T extends SessionSidebarTreeRow>(
  rows: readonly T[],
  args: {
    workersByRowKey: ReadonlyMap<string, readonly T[]>
    classifications: Map<string, string>
    compare: (a: T, b: T) => number
    searching: boolean
    viewKey: (row: T) => string
  }
): T[] {
  if (args.workersByRowKey.size === 0) {
    return [...rows]
  }
  const listed: T[] = []
  for (const row of rows) {
    listed.push(row)
    const workers = args.workersByRowKey.get(row.session.rowKey)
    if (!workers || (!args.searching && !row.workers?.expanded)) {
      continue
    }
    const classification = args.classifications.get(row.session.rowKey)
    for (const worker of [...workers].sort(args.compare)) {
      if (args.searching) {
        listed.push(worker)
        continue
      }
      // Why: a listed worker sits in its launcher's group, whatever its own state.
      if (classification) {
        args.classifications.set(worker.session.rowKey, classification)
      }
      listed.push({
        ...worker,
        workerOf: args.viewKey(row),
        folderId: row.folderId,
        archived: row.archived
      })
    }
  }
  return listed
}
