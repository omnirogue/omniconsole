import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
import { consoleWorkflowApi, workflowData } from './console-workflow-client'
import type { ConsoleWorkflowProgress } from '../../../shared/console-workflow-types'

const requests = new PrioritySemaphore(BACKOFFICE_POLLING.graphMaxInFlight)
type Entry = { workflowId: string; digest?: string; promise: Promise<ConsoleWorkflowProgress> }
type ScopeReads = { tick: number; entries: Map<string, Entry>; latest: Map<string, Entry> }
const scopes = new Map<string, ScopeReads>()

export function clearWorkflowGraphReads(scope: string): void {
  scopes.delete(scope)
}

/** A digest identifies the graph, not execution progress; refresh once each cadence tick. */
export function readWorkflowGraph(
  scope: string,
  workflowId: string,
  digest?: string
): Promise<ConsoleWorkflowProgress> {
  const tick = Math.floor(Date.now() / BACKOFFICE_POLLING.focusedMs)
  let graphs = scopes.get(scope)
  if (!graphs || graphs.tick !== tick) {
    graphs = { tick, entries: new Map(), latest: new Map() }
    scopes.delete(scope)
    scopes.set(scope, graphs)
    while (scopes.size > BACKOFFICE_POLLING.graphScopeCacheLimit) {
      scopes.delete(scopes.keys().next().value!)
    }
  }
  const key = JSON.stringify([workflowId, digest ?? null])
  const latest = graphs.latest.get(workflowId)
  const previous =
    digest === undefined
      ? latest
      : (graphs.entries.get(key) ?? (latest?.digest === undefined ? latest : undefined))
  if (previous) {
    previous.digest ??= digest
    graphs.entries.set(key, previous)
    return previous.promise
  }
  const promise = (async () => {
    const release = await requests.acquire(0)
    try {
      const result = workflowData(await consoleWorkflowApi().getWorkflow({ workflowId }))
      if (result.workflow_id !== workflowId) {
        throw new Error('The server returned a different workflow identity.')
      }
      return result
    } finally {
      release()
    }
  })()
  const entry = { workflowId, digest, promise }
  graphs.entries.set(key, entry)
  graphs.latest.set(workflowId, entry)
  return promise
}

const refreshing = new Map<string, Promise<ConsoleWorkflowProgress>>()

/** User refreshes supersede cached and pending reads; the semaphore still serializes HTTP calls. */
export function refreshWorkflowGraph(
  scope: string,
  workflowId: string
): Promise<ConsoleWorkflowProgress> {
  const key = JSON.stringify([scope, workflowId])
  const pending = refreshing.get(key)
  if (pending) {
    return pending
  }
  const graphs = scopes.get(scope)
  const digest = graphs?.latest.get(workflowId)?.digest
  for (const [entryKey, entry] of graphs?.entries ?? []) {
    if (entry.workflowId === workflowId) {
      graphs?.entries.delete(entryKey)
    }
  }
  graphs?.latest.delete(workflowId)
  const promise = readWorkflowGraph(scope, workflowId, digest)
  refreshing.set(key, promise)
  void promise
    .finally(() => {
      refreshing.delete(key)
    })
    .catch(() => undefined)
  return promise
}
