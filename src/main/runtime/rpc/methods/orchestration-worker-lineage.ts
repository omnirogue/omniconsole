import { z } from 'zod'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  WorkerLineageChild,
  WorkerLineageLink,
  WorkerLineageResult
} from '../../../../shared/worker-lineage'
import type { WorkerLineageRow } from '../../orchestration/db/dispatch-context/worker-lineage'
import { parseWorkerTerminalHostScope } from '../../orchestration/worker-terminal-process-liveness'
import { exposeUtcTimestamp } from '../../orchestration/db/utc-timestamp'
import { defineMethod, type RpcMethod } from '../core'

type PaneKeyResolver = (handle: string) => string | null
type CurrentPaneIncarnationResolver = (paneKey: string) => string | null

function lineageChild(
  row: WorkerLineageRow,
  paneKeyFor: PaneKeyResolver
): WorkerLineageChild | null {
  if (row.environment_id && row.remote_terminal) {
    return {
      kind: 'remote-terminal',
      environmentId: row.environment_id,
      terminal: row.remote_terminal
    }
  }
  const paneKey = row.child_pane_key || (row.child_handle ? paneKeyFor(row.child_handle) : null)
  return paneKey ? { kind: 'pane', paneKey } : null
}

// Why the leaf: it is the remint-stable half of a pane key (see pane-key-match).
function paneIdentity(paneKey: string): string {
  return parsePaneKey(paneKey)?.leafId ?? paneKey
}

/** One link per worker: the first session that dispatched to it launched it; later reuse does not. */
export function workerLineageLinks(
  rows: readonly WorkerLineageRow[],
  paneKeyFor: PaneKeyResolver,
  currentPaneIncarnationFor: CurrentPaneIncarnationResolver = () => null
): WorkerLineageLink[] {
  const links: WorkerLineageLink[] = []
  const linkIndexByIdentity = new Map<string, number>()
  for (const row of rows) {
    const child = lineageChild(row, paneKeyFor)
    if (!child) {
      continue
    }
    const identity =
      child.kind === 'pane'
        ? `pane:${paneIdentity(child.paneKey)}`
        : `remote:${child.environmentId}:${child.terminal}`
    const existingIndex = linkIndexByIdentity.get(identity)
    if (existingIndex !== undefined) {
      // Grouping stays with the first dispatcher; retention follows the current exact owner.
      if (child.kind === 'pane') {
        const currentIncarnation = currentPaneIncarnationFor(child.paneKey)
        const ownerIncarnation = row.resource_process_incarnation ?? null
        const currentOwnerIsProven = Boolean(
          row.resource_owner_dispatch_id &&
          ownerIncarnation &&
          ownerIncarnation === currentIncarnation &&
          parseWorkerTerminalHostScope(row.resource_host_scope)?.kind === 'local'
        )
        const previous = links[existingIndex]!
        links[existingIndex] = {
          ...previous,
          dispatchId: currentOwnerIsProven ? row.resource_owner_dispatch_id! : undefined,
          processIncarnation: currentOwnerIsProven ? ownerIncarnation! : undefined,
          retainedByUser: Boolean(row.resource_owner_dispatch_id && row.retained_by_user === 1)
        }
      }
      continue
    }
    const parentPaneKey =
      row.parent_pane_key || (row.parent_handle ? paneKeyFor(row.parent_handle) : null)
    if (
      !parentPaneKey ||
      (child.kind === 'pane' && paneIdentity(child.paneKey) === paneIdentity(parentPaneKey))
    ) {
      continue
    }
    linkIndexByIdentity.set(identity, links.length)
    const dispatchedAt = Date.parse(exposeUtcTimestamp(row.dispatched_at) ?? '')
    const ownerIncarnation = row.resource_process_incarnation ?? null
    const currentOwnerIsProven = Boolean(
      child.kind === 'pane' &&
      row.resource_owner_dispatch_id &&
      ownerIncarnation &&
      ownerIncarnation === currentPaneIncarnationFor(child.paneKey) &&
      parseWorkerTerminalHostScope(row.resource_host_scope)?.kind === 'local'
    )
    links.push({
      ...(child.kind === 'pane'
        ? { retainedByUser: Boolean(row.resource_owner_dispatch_id && row.retained_by_user === 1) }
        : {}),
      ...(currentOwnerIsProven
        ? { dispatchId: row.resource_owner_dispatch_id!, processIncarnation: ownerIncarnation! }
        : {}),
      parentPaneKey,
      child,
      dispatchedAt: Number.isFinite(dispatchedAt) ? dispatchedAt : 0
    })
  }
  return links
}

export const ORCHESTRATION_WORKER_LINEAGE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerLineage',
    params: z.object({}).optional(),
    // Read-only: which session dispatched each worker, so the sidebar can nest workers under it.
    handler: (_params, { runtime }): WorkerLineageResult => {
      const db = runtime.getOrchestrationDb()
      if (!db.hasAnyDispatchContexts()) {
        return { links: [] }
      }
      return {
        links: workerLineageLinks(
          db.listWorkerLineage(),
          (handle) => runtime.getTerminalPaneKey(handle),
          (paneKey) => {
            const handle = runtime.getTerminalHandleForPaneKey(paneKey)
            if (!handle || runtime.getLiveTerminalPaneKey(handle) !== paneKey) {
              return null
            }
            return runtime.getTerminalProcessIncarnation(handle)
          }
        )
      }
    }
  })
]
