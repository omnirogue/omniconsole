import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { LocalWorkflowChangedEvent } from '../../../../shared/local-workflow-rpc'

/**
 * Why a started run's state is not shown (C6): the controller that owns it has no such run
 * (`missing`, "run not found"), or the read failed or answered nothing (`failed`, "status
 * unavailable"). Neither is completion or cancellation evidence. Cleared by any real status.
 */
export type LocalWorkflowHydrationOutcome = {
  /** The run read: an execution, Evolve run or Build + Review pipeline id. */
  runId: string
  outcome: 'missing' | 'failed'
  /** Reads tried since the last re-arm (reconnect, focus or manual refresh). */
  attempts: number
  reason?: string
}

export type LocalWorkflowStatusSlice = {
  /**
   * Latest Council/Discover status per conversation (tab) id, pushed by the host so tab strips and
   * sidebar rows stay current while the conversation itself is hidden. In memory only.
   */
  localWorkflowStatusByTabId: Record<string, LocalWorkflowChangedEvent>
  setLocalWorkflowStatus: (status: LocalWorkflowChangedEvent) => void
  /** Per conversation (tab) id: a run whose read found no run or failed. In memory only. */
  localWorkflowHydrationByTabId: Record<string, LocalWorkflowHydrationOutcome>
  /** Records (or, with null, clears) a tab's read outcome. */
  setLocalWorkflowHydration: (tabId: string, outcome: LocalWorkflowHydrationOutcome | null) => void
  /**
   * A manual refresh: status hydration re-arms reads that failed or ran out of retries, for one
   * conversation (`tabId`) or for every one (null). `count` changes on every request.
   */
  localWorkflowHydrationRefresh: { count: number; tabId: string | null }
  refreshLocalWorkflowStatuses: (tabId?: string) => void
}

function sameStatus(left: LocalWorkflowChangedEvent, right: LocalWorkflowChangedEvent): boolean {
  return (
    left.executionId === right.executionId &&
    left.preset === right.preset &&
    left.state === right.state &&
    left.running === right.running &&
    left.completed === right.completed &&
    left.total === right.total &&
    left.phase === right.phase &&
    left.host === right.host &&
    left.requestedBy === right.requestedBy &&
    left.requestedById === right.requestedById
  )
}

function sameOutcome(
  left: LocalWorkflowHydrationOutcome | undefined,
  right: LocalWorkflowHydrationOutcome
): boolean {
  return (
    left?.runId === right.runId &&
    left.outcome === right.outcome &&
    left.attempts === right.attempts &&
    left.reason === right.reason
  )
}

export const createLocalWorkflowStatusSlice: StateCreator<
  AppState,
  [],
  [],
  LocalWorkflowStatusSlice
> = (set) => ({
  localWorkflowStatusByTabId: {},
  localWorkflowHydrationByTabId: {},
  localWorkflowHydrationRefresh: { count: 0, tabId: null },
  setLocalWorkflowStatus: (status) =>
    set((state) => {
      const current = state.localWorkflowStatusByTabId[status.conversationId]
      const outcome = state.localWorkflowHydrationByTabId[status.conversationId]
      // Why: a real status for the run supersedes a not-found or failed read of it.
      const clearsOutcome = outcome?.runId === status.executionId
      // Why: an unchanged status must not republish the map and re-render every tab and row.
      if (current && sameStatus(current, status) && !clearsOutcome) {
        return state
      }
      let hydration = state.localWorkflowHydrationByTabId
      if (clearsOutcome) {
        hydration = { ...hydration }
        delete hydration[status.conversationId]
      }
      return {
        localWorkflowStatusByTabId: {
          ...state.localWorkflowStatusByTabId,
          [status.conversationId]: status
        },
        localWorkflowHydrationByTabId: hydration
      }
    }),
  setLocalWorkflowHydration: (tabId, outcome) =>
    set((state) => {
      const current = state.localWorkflowHydrationByTabId[tabId]
      if (outcome ? sameOutcome(current, outcome) : !current) {
        return state
      }
      const next = { ...state.localWorkflowHydrationByTabId }
      if (outcome) {
        next[tabId] = outcome
      } else {
        delete next[tabId]
      }
      return { localWorkflowHydrationByTabId: next }
    }),
  refreshLocalWorkflowStatuses: (tabId) =>
    set((state) => ({
      localWorkflowHydrationRefresh: {
        count: state.localWorkflowHydrationRefresh.count + 1,
        tabId: tabId ?? null
      }
    }))
})
