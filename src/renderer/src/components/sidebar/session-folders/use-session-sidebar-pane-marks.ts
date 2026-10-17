import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useReturnedMarks } from '@/store/wait-later-store'
import { useStewardStalledPaneKeys } from '@/lib/session-steward-client'
import { useWorkerParentLeaves } from './use-worker-parent-leaves'
import type { WorkerLineageActionIdentity } from '../../../../../shared/worker-lineage'

/**
 * The per-pane marks the tree reads: when a retained agent started, what a plan handed back,
 * which panes the session steward lists as Stalled, and which session launched each worker.
 */
export function useSessionSidebarPaneMarks(): {
  retainedStartedAtByPaneKey: ReadonlyMap<string, number>
  returnedByPaneKey: ReadonlyMap<string, number>
  stalledPaneKeys: ReadonlySet<string>
  workerParentByLeaf: ReadonlyMap<string, string>
  workerDispatchByLeaf: ReadonlyMap<string, WorkerLineageActionIdentity>
  workerSubagentLeaves: ReadonlySet<string>
} {
  const retained = useAppStore((state) => state.retainedAgentsByPaneKey)
  const retainedStartedAtByPaneKey = useMemo(
    () => new Map(Object.entries(retained).map(([key, value]) => [key, value.startedAt])),
    [retained]
  )
  // Why: a plan that ended with ↩ Back to me hands its source row back as "needs you".
  const returnedMarks = useReturnedMarks()
  const returnedByPaneKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const [key, at] of returnedMarks) {
      if (key.startsWith('pane:')) {
        map.set(key.slice('pane:'.length), at)
      }
    }
    return map
  }, [returnedMarks])
  const stalledPaneKeys = useStewardStalledPaneKeys()
  const {
    parents: workerParentByLeaf,
    dispatchIds: workerDispatchByLeaf,
    subagentLeaves: workerSubagentLeaves
  } = useWorkerParentLeaves()
  return useMemo(
    () => ({
      retainedStartedAtByPaneKey,
      returnedByPaneKey,
      stalledPaneKeys,
      workerParentByLeaf,
      workerDispatchByLeaf,
      workerSubagentLeaves
    }),
    [
      retainedStartedAtByPaneKey,
      returnedByPaneKey,
      stalledPaneKeys,
      workerParentByLeaf,
      workerDispatchByLeaf,
      workerSubagentLeaves
    ]
  )
}
