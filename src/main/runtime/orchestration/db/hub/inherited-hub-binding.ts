import { findPotentiallyLiveAttachmentsForCreator } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'
import { isEquivalentPaneKey } from '../pane-key-match'

export function resolveInheritedHubBinding(
  db: OrchestrationDb,
  params: {
    coordinatorHandle: string
    coordinatorPaneKey: string
    coordinatorProcessIncarnation?: string
    hubTaskId?: string
    hubStateRevision?: number
  }
): { hubTaskId?: string; hubStateRevision?: number; canonicalOrigin?: boolean } {
  const latest = db.getLatestDispatchForTerminal(params.coordinatorHandle)
  const retained =
    latest &&
    (!latest.assignee_pane_key ||
      isEquivalentPaneKey(latest.assignee_pane_key, params.coordinatorPaneKey)) &&
    (!latest.process_incarnation ||
      !params.coordinatorProcessIncarnation ||
      latest.process_incarnation === params.coordinatorProcessIncarnation)
      ? latest
      : undefined
  const bindings = [
    db.getCurrentRunForPane(params.coordinatorPaneKey),
    db.findActiveDispatchForAssignee(params.coordinatorHandle, params.coordinatorPaneKey),
    retained,
    ...findPotentiallyLiveAttachmentsForCreator.call(db, {
      kind: 'terminal',
      handle: params.coordinatorHandle,
      paneKey: params.coordinatorPaneKey,
      processIncarnation: params.coordinatorProcessIncarnation
    })
  ].filter((row) => row?.hub_task_id)
  const cardIds = new Set(bindings.map((row) => row?.hub_task_id))
  if (cardIds.size > 1) {
    throw new Error('Conflicting inherited omnios card identities; refuse a new run.')
  }
  const inherited = bindings[0]
  if (!inherited?.hub_task_id) {
    return params
  }
  if (params.hubTaskId && params.hubTaskId !== inherited.hub_task_id) {
    throw new Error(`This execution must inherit omnios card ${inherited.hub_task_id}.`)
  }
  return {
    hubTaskId: inherited.hub_task_id,
    hubStateRevision: inherited.hub_state_revision ?? params.hubStateRevision,
    // Why: a new Run started from inside a Hub-dispatched execution inherits that
    // execution's ownership too. Without this a canonical worker could create a
    // sibling Run for the same card and start local workers outside Hub admission.
    canonicalOrigin: bindings.some((row) => isHubDispatchedSource(db, row))
  }
}

function isHubDispatchedSource(db: OrchestrationDb, row: unknown): boolean {
  const source = row as { run_id?: string; id?: string } | undefined
  const runId = source?.run_id ?? source?.id
  return runId !== undefined && db.getRun(runId)?.origin === 'hub_dispatched'
}
