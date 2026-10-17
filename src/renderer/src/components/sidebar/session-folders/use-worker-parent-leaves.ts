import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  readRememberedWorkerParents,
  resolveUserRetainedWorkerLeaves,
  resolveWorkerDispatchIds,
  resolveWorkerParentLeaves,
  resolveWorkerSubagentLeaves,
  saveRememberedWorkerParents
} from '@/lib/worker-lineage-parents'
import type {
  WorkerLineageActionIdentity,
  WorkerLineageLink,
  WorkerLineageResult
} from '../../../../../shared/worker-lineage'

const POLL_MS = 15_000
const NO_LINKS: readonly WorkerLineageLink[] = []

function sameParents(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value)
}

/**
 * Worker pane leaf → the leaf of the session that dispatched it, from this runtime's orchestration
 * record (`orchestration.workerLineage`). Keeps its identity while nothing changes, so the tree is
 * not rebuilt on every poll.
 */
export function useWorkerParentLeaves(): {
  parents: ReadonlyMap<string, string>
  dispatchIds: ReadonlyMap<string, WorkerLineageActionIdentity>
  subagentLeaves: ReadonlySet<string>
} {
  const [links, setLinks] = useState<readonly WorkerLineageLink[]>(NO_LINKS)
  useEffect(() => {
    let cancelled = false
    let requestSequence = 0
    const load = (): void => {
      const sequence = ++requestSequence
      callRuntimeRpc<WorkerLineageResult>(
        { kind: 'local' },
        'orchestration.workerLineage',
        {},
        { timeoutMs: 10_000 }
      )
        .then((result) => {
          if (!cancelled && sequence === requestSequence && Array.isArray(result?.links)) {
            setLinks((prior) =>
              JSON.stringify(prior) === JSON.stringify(result.links) ? prior : result.links
            )
          }
        })
        // An older runtime has no lineage: workers are then listed as before.
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener('omni.worker-lineage-refresh', load)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('omni.worker-lineage-refresh', load)
    }
  }, [])
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const resolved = useMemo(
    () =>
      resolveWorkerParentLeaves({
        links,
        terminalLayoutsByTabId: terminalLayoutsByTabId ?? {},
        tabsByWorktree: tabsByWorktree ?? {}
      }),
    [links, terminalLayoutsByTabId, tabsByWorktree]
  )
  const dispatchIds = useMemo(
    () =>
      resolveWorkerDispatchIds({
        links,
        terminalLayoutsByTabId: terminalLayoutsByTabId ?? {},
        tabsByWorktree: tabsByWorktree ?? {}
      }),
    [links, terminalLayoutsByTabId, tabsByWorktree]
  )
  const subagentLeaves = useMemo(
    () =>
      resolveWorkerSubagentLeaves({
        links,
        terminalLayoutsByTabId: terminalLayoutsByTabId ?? {},
        tabsByWorktree: tabsByWorktree ?? {}
      }),
    [links, terminalLayoutsByTabId, tabsByWorktree]
  )
  const retainedLeaves = useMemo(
    () =>
      resolveUserRetainedWorkerLeaves({
        links,
        terminalLayoutsByTabId: terminalLayoutsByTabId ?? {},
        tabsByWorktree: tabsByWorktree ?? {}
      }),
    [links, terminalLayoutsByTabId, tabsByWorktree]
  )
  const [parents, setParents] = useState<ReadonlyMap<string, string>>(readRememberedWorkerParents)
  useEffect(() => {
    setParents((prior) => {
      const next = new Map(prior)
      for (const leaf of retainedLeaves) {
        next.delete(leaf)
      }
      for (const [child, parent] of resolved) {
        // Why delete first: a refreshed link moves to the end, so the cap drops the oldest.
        next.delete(child)
        next.set(child, parent)
      }
      return sameParents(next, prior) ? prior : next
    })
  }, [resolved, retainedLeaves])
  useEffect(() => saveRememberedWorkerParents(parents), [parents])
  return useMemo(
    () => ({ parents, dispatchIds, subagentLeaves }),
    [parents, dispatchIds, subagentLeaves]
  )
}
