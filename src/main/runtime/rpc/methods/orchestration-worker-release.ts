import { z } from 'zod'
import type { WorkerTerminalListState } from '../../orchestration/worker-terminal-ownership'
import { parseWorkerTerminalHostScope } from '../../orchestration/worker-terminal-process-liveness'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { workerTerminalReleaseLeaseIsCurrent } from './orchestration-worker-terminal-lease'
import {
  workerTerminalCloseIssued,
  workerTerminalPaneCloseIssued
} from './orchestration-worker-release-activity'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  exposeWorkerTerminalResource,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
const WorkerRetainParams = WorkerDispatchParams.extend({
  expectedPaneKey: z.string().min(1).optional(),
  expectedProcessIncarnation: z.string().min(1).optional()
}).refine(
  ({ expectedPaneKey, expectedProcessIncarnation }) =>
    Boolean(expectedPaneKey) === Boolean(expectedProcessIncarnation),
  'Expected pane and process incarnation must be supplied together.'
)

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

const WorkerListParams = z.object({
  run: z.string().min(1).optional(),
  terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional()
})

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRelease',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      if (db.getFederatedDispatch(params.dispatch)) {
        // Fail closed: the worker server owns that terminal; a home-side close would be a guess.
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: 'federation_unsupported',
          processAction: 'none',
          archive: null,
          recovery:
            'Connected-server workers do not support release yet; inspect the worker server directly.'
        }
      }
      const requested = db.requestWorkerTerminalRelease(params.dispatch)
      if (requested.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released',
          processAction: 'none',
          archive: archiveSummary(requested.resource)
        }
      }
      if (requested.disposition === 'retained') {
        const resource = requested.resource
        const processIncarnation = resource?.process_incarnation
        if (
          processIncarnation &&
          (await runtime.inspectTerminalProcessIncarnationLiveness(
            processIncarnation,
            resource.host_scope
          )) === 'exited'
        ) {
          const reconciled = db.settleDeadWorkerTerminalRelease({
            requestingDispatchId: params.dispatch,
            resourceId: resource.id,
            processIncarnation
          })
          if (reconciled.disposition === 'released') {
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
            return {
              dispatchId: params.dispatch,
              state: 'released',
              processAction: 'none',
              archive: archiveSummary(reconciled.resource)
            }
          }
        }
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: requested.reason,
          processAction: 'none',
          archive: archiveSummary(resource)
        }
      }
      return completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: params.dispatch,
        resource: requested.resource
      })
    }
  }),
  defineMethod({
    name: 'orchestration.workerRetain',
    params: WorkerRetainParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      const expectedIdentity =
        params.expectedPaneKey && params.expectedProcessIncarnation
          ? {
              paneKey: params.expectedPaneKey,
              processIncarnation: params.expectedProcessIncarnation
            }
          : undefined
      const identityIsCurrent = (): boolean =>
        !expectedIdentity ||
        Boolean(
          resource &&
          resource.pane_key === expectedIdentity.paneKey &&
          resource.process_incarnation === expectedIdentity.processIncarnation &&
          parseWorkerTerminalHostScope(resource.host_scope)?.kind === 'local' &&
          runtime.getLiveTerminalPaneKey(resource.terminal_handle) === expectedIdentity.paneKey &&
          runtime.getTerminalProcessIncarnation(resource.terminal_handle) ===
            expectedIdentity.processIncarnation
        )
      const staleIdentityReceipt = () => ({
        dispatchId: params.dispatch,
        state: 'retained' as const,
        reason: 'identity_unproven' as const,
        processAction: 'none' as const,
        archive: null
      })
      if (!identityIsCurrent()) {
        return staleIdentityReceipt()
      }
      let allowReleasing = false
      if (
        resource?.release_state === 'releasing' &&
        !workerTerminalCloseIssued(runtime, resource.id) &&
        resource.ownership_state === 'owned' &&
        resource.worktree_id &&
        resource.pane_key &&
        resource.process_incarnation &&
        resource.host_scope &&
        runtime.getAutomaticCleanupTab(resource.worktree_id, resource.pane_key) &&
        (await runtime.inspectTerminalProcessIncarnationLiveness(
          resource.process_incarnation,
          resource.host_scope
        )) === 'live' &&
        workerTerminalReleaseLeaseIsCurrent(runtime, db, params.dispatch, resource) &&
        !workerTerminalCloseIssued(runtime, resource.id)
      ) {
        allowReleasing = true
      }
      // The liveness check above may yield; confirm the proof again immediately before the
      // transactional compare-and-retain so a replacement process cannot inherit the click.
      if (!identityIsCurrent()) {
        return staleIdentityReceipt()
      }
      const retained = db.retainWorkerTerminalResource(
        params.dispatch,
        allowReleasing,
        expectedIdentity
      )
      if (retained.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released' as const,
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource)
        }
      }
      if (retained.disposition === 'no_owned_resource') {
        return {
          dispatchId: params.dispatch,
          state: 'retained' as const,
          reason: 'no_owned_resource' as const,
          processAction: 'none' as const,
          archive: null
        }
      }
      if (retained.disposition === 'stale_identity') {
        return staleIdentityReceipt()
      }
      if (retained.disposition === 'release_committed') {
        const unknown = retained.resource.release_state === 'unknown'
        return {
          dispatchId: params.dispatch,
          state: unknown ? ('release_unknown' as const) : ('release_pending' as const),
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource),
          ...(retained.resource.release_error
            ? { lastError: retained.resource.release_error }
            : {}),
          recovery:
            'Terminal release was already committed and could not be changed to retained; inspect worker-show before taking further action.'
        }
      }
      return {
        dispatchId: params.dispatch,
        state: 'retained' as const,
        reason: 'user_requested' as const,
        processAction: 'none' as const,
        archive: archiveSummary(retained.resource)
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerList',
    params: WorkerListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const rows = db.listWorkerTerminalResources({ runId: params.run })
      const workers = rows
        .filter((row) => !params.terminalState || row.terminalState === params.terminalState)
        .map((row) => ({
          dispatchId: row.dispatchId,
          taskId: row.taskId,
          runId: row.runId,
          workerState: row.workerState,
          dispatchStatus: row.dispatchStatus,
          agentTerminalHandle: row.agentTerminalHandle,
          terminalState: row.terminalState,
          resource: row.resource ? exposeWorkerTerminalResource(row.resource) : null
        }))
      const counts: Partial<Record<WorkerTerminalListState, number>> = {}
      for (const row of rows) {
        if (row.terminalState) {
          counts[row.terminalState] = (counts[row.terminalState] ?? 0) + 1
        }
      }
      return { workers, counts }
    }
  }),
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    params: z.object({ paneKey: requiredString('Missing paneKey') }),
    // Real user keystrokes durably relinquish orchestration ownership on the owning runtime, so
    // restarts, SSH drops, remote viewing, and renderer remounts cannot erase the takeover.
    handler: (params, { runtime }) => ({
      changed: workerTerminalPaneCloseIssued(runtime, params.paneKey)
        ? 0
        : runtime.getOrchestrationDb().markWorkerTerminalUserOwned(params.paneKey)
    })
  })
]
