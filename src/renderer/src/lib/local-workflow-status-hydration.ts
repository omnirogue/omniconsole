import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowChangedEvent
} from '../../../shared/local-workflow-rpc'
import { EVOLVE_RPC, type EvolveRunRecord } from '../../../shared/evolve-workflow'
import { evolveChangedEvent } from '../../../shared/evolve-workflow-status'
import { isWorkflowRunNotFound } from '../../../shared/session-workflow-anchor'

/** A refused or failed read is tried again this much later, at most three times per run. */
export const LOCAL_WORKFLOW_HYDRATION_RETRY_MS = 15_000
const MAX_TRIES = 3
const LIST_KEY = 'build-review:list'
/** A reconnect, focus or refresh re-arms a run's reads at most this often. */
export const LOCAL_WORKFLOW_HYDRATION_REARM_MS = 5_000

type AppState = ReturnType<typeof useAppStore.getState>
type ReadOutcome = { status: LocalWorkflowChangedEvent } | { missing: true } | { failed: string }

/**
 * The controller's session came back: the window's sessions finished restoring, or an SSH host a
 * workspace runs on connected again (the controller resolves that workspace to read its run).
 */
function ownerReconnected(previous: AppState, state: AppState): boolean {
  if (state.workspaceSessionReady && !previous.workspaceSessionReady) {
    return true
  }
  if (state.sshConnectionStates === previous.sshConnectionStates) {
    return false
  }
  for (const [targetId, connection] of state.sshConnectionStates ?? new Map()) {
    if (
      connection.status === 'connected' &&
      previous.sshConnectionStates?.get(targetId)?.status !== 'connected'
    ) {
      return true
    }
  }
  return false
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pushes only describe runs that change while the app is open. After a restart each started
 * Council, Discover or Evolve tab asks for its run's status (no recovery, no resume), and Build +
 * Review lists its pipelines, so hidden tabs and sidebar rows show the real state.
 *
 * Every read goes to the controller that owns the run — this computer's runtime, which started it
 * (`local-workflow-graph-start.ts`) — whatever host runs the workspace. Each outcome is stored: a
 * run the controller does not have is "run not found", a failed or empty read "status
 * unavailable"; neither is ever a pending launch. Failed reads retry a bounded number of times,
 * and a reconnect, window focus or manual refresh re-arms them.
 */
export function installLocalWorkflowStatusHydration(): () => void {
  const tries = new Map<string, number>()
  const lastTriedAt = new Map<string, number>()
  // Why per run: one run's retry timer must not spend another run's tries early.
  const nextAttemptAt = new Map<string, number>()
  const due = (key: string) => Date.now() >= (nextAttemptAt.get(key) ?? 0)
  const pending = new Set<string>()
  const pipelines = new Set<string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let seen: AppState['tabsByWorktree'] | undefined
  let disposed = false

  const readStatus = async (worktreeId: string, tabId: string, executionId: string) =>
    callRuntimeRpc<LocalWorkflowChangedEvent | null>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.status,
      { worktree: toRuntimeWorktreeSelector(worktreeId), conversationId: tabId, executionId }
    )
  // Evolve runs live in this computer's main process, whatever the workspace.
  const readEvolve = async (tabId: string, id: string) => {
    const { run } = await callRuntimeRpc<{ run: EvolveRunRecord }>(
      { kind: 'local' },
      EVOLVE_RPC.show,
      { id }
    )
    return evolveChangedEvent({ ...run, conversationId: tabId })
  }

  const retryLater = (key: string) => {
    if ((tries.get(key) ?? 0) >= MAX_TRIES || disposed) {
      return
    }
    nextAttemptAt.set(key, Date.now() + LOCAL_WORKFLOW_HYDRATION_RETRY_MS)
    const timer = setTimeout(() => {
      timers.delete(timer)
      seen = undefined
      scan()
    }, LOCAL_WORKFLOW_HYDRATION_RETRY_MS)
    timers.add(timer)
  }

  const record = (tabId: string, runId: string, key: string, outcome: ReadOutcome) => {
    const state = useAppStore.getState()
    // Why: a push that arrived meanwhile is newer than this read.
    if (disposed || state.localWorkflowStatusByTabId[tabId]?.executionId === runId) {
      return
    }
    if ('status' in outcome) {
      state.setLocalWorkflowStatus(outcome.status)
      return
    }
    state.setLocalWorkflowHydration(tabId, {
      runId,
      outcome: 'missing' in outcome ? 'missing' : 'failed',
      attempts: tries.get(key) ?? 1,
      ...('failed' in outcome ? { reason: outcome.failed } : {})
    })
    if ('failed' in outcome) {
      retryLater(key)
    }
  }

  const read = async (
    worktreeId: string,
    tabId: string,
    executionId: string,
    key: string,
    evolve: boolean
  ) => {
    pending.add(key)
    lastTriedAt.set(key, Date.now())
    let outcome: ReadOutcome
    try {
      const status = evolve
        ? await readEvolve(tabId, executionId)
        : await readStatus(worktreeId, tabId, executionId)
      // Why: an answer with no status is not one; it must neither stick nor read as absence.
      outcome = status ? { status } : { failed: 'The controller answered with no status.' }
    } catch (error) {
      outcome = isWorkflowRunNotFound(error) ? { missing: true } : { failed: failureReason(error) }
    } finally {
      pending.delete(key)
    }
    record(tabId, executionId, key, outcome)
  }

  const listPipelines = async (state: AppState, waiting: Map<string, string>) => {
    const key = LIST_KEY
    tries.set(key, (tries.get(key) ?? 0) + 1)
    lastTriedAt.set(key, Date.now())
    pending.add(key)
    const listed = await state.buildReview.refreshAll().catch(() => false)
    pending.delete(key)
    if (disposed) {
      return
    }
    const after = useAppStore.getState()
    for (const [tabId, id] of waiting) {
      if (listed) {
        after.setLocalWorkflowHydration(tabId, null)
        continue
      }
      // Why: an unlisted pipeline is unread, not ended; mark it so a later scan asks again.
      pipelines.delete(id)
      after.setLocalWorkflowHydration(tabId, {
        runId: id,
        outcome: 'failed',
        attempts: tries.get(key) ?? 1,
        ...(after.buildReview.error ? { reason: after.buildReview.error } : {})
      })
    }
    if (!listed) {
      retryLater(key)
    }
  }

  const scan = () => {
    const state = useAppStore.getState()
    if (disposed || state.tabsByWorktree === seen) {
      return
    }
    seen = state.tabsByWorktree
    const waitingPipelines = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
      for (const tab of tabs) {
        const workflow = tab.localWorkflow
        if (workflow?.preset === 'build-review') {
          const id = workflow.buildReviewPipelineId
          if (id && !state.buildReview.pipelinesById[id] && !state.buildReview.pipelinesListed) {
            waitingPipelines.set(tab.id, id)
          }
          continue
        }
        const executionId = workflow?.executionId
        if (!executionId || state.localWorkflowStatusByTabId[tab.id]?.executionId === executionId) {
          continue
        }
        const key = `${tab.id}:${executionId}`
        const outcome = state.localWorkflowHydrationByTabId[tab.id]
        if (
          pending.has(key) ||
          !due(key) ||
          (tries.get(key) ?? 0) >= MAX_TRIES ||
          // Why: "run not found" is the controller's answer; only a re-arm asks again.
          (outcome?.runId === executionId && outcome.outcome === 'missing' && tries.has(key))
        ) {
          continue
        }
        tries.set(key, (tries.get(key) ?? 0) + 1)
        void read(worktreeId, tab.id, executionId, key, workflow?.preset === 'evolve')
      }
    }
    const unread = [...waitingPipelines.values()].filter((id) => !pipelines.has(id))
    if (
      unread.length &&
      !pending.has(LIST_KEY) &&
      due(LIST_KEY) &&
      (tries.get(LIST_KEY) ?? 0) < MAX_TRIES
    ) {
      unread.forEach((id) => pipelines.add(id))
      void listPipelines(state, waitingPipelines)
    }
  }

  /**
   * Reconnect, focus or a manual refresh: runs that ran out of tries, failed or were not found
   * are read again — every run, or one conversation's (`tabId`) and the pipeline list.
   */
  const rearm = (tabId: string | null = null) => {
    const now = Date.now()
    for (const key of tries.keys()) {
      if (
        (tabId === null || key === LIST_KEY || key.startsWith(`${tabId}:`)) &&
        !pending.has(key) &&
        now - (lastTriedAt.get(key) ?? 0) >= LOCAL_WORKFLOW_HYDRATION_REARM_MS
      ) {
        tries.delete(key)
        nextAttemptAt.delete(key)
      }
    }
    pipelines.clear()
    seen = undefined
    scan()
  }

  let previous = useAppStore.getState()
  const unsubscribe = useAppStore.subscribe(() => {
    const state = useAppStore.getState()
    const refresh = state.localWorkflowHydrationRefresh
    const refreshed = refresh.count !== previous.localWorkflowHydrationRefresh.count
    const reconnected = ownerReconnected(previous, state)
    previous = state
    if (refreshed || reconnected) {
      rearm(refreshed && !reconnected ? refresh.tabId : null)
    } else {
      scan()
    }
  })
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rearm(null)
    }
  }
  // Why: hosts and test harnesses can supply a partial window without event listeners.
  const target =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null
  const doc = typeof target?.document?.addEventListener === 'function' ? target.document : null
  target?.addEventListener('focus', onVisible)
  doc?.addEventListener('visibilitychange', onVisible)
  scan()
  return () => {
    disposed = true
    unsubscribe()
    target?.removeEventListener('focus', onVisible)
    doc?.removeEventListener('visibilitychange', onVisible)
    timers.forEach(clearTimeout)
    timers.clear()
  }
}
