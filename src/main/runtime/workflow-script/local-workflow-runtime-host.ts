import { getAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../omni-runtime'
import { listLocalWorkflowScope, materializeLocalWorkflowScope } from './local-workflow-scope'
import { workflowEvidenceDigest } from './workflow-checkpoint-store'
import { captureWorkflowOwner } from './workflow-owner-claim'
import { defaultWorkflowScriptSlots, WorkflowScriptSlots } from './workflow-script-slots'
import { LocalWorkflowHost } from './local-workflow-host'
import { catalog, preflight } from './local-workflow-provider-catalog'
import {
  refreshWorkflowCapacity,
  workflowSeatCapacityNow
} from './local-workflow-capacity-readings'
import { attestNativeResult, launch } from './local-workflow-provider-launch'
import { placeLocalWorkflow } from './local-workflow-fleet-placement'
import {
  discardWorkflowFleetDispatch,
  finishWorkflowFleetDispatch
} from './workflow-fleet-retention'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { readyWorkflowFleetDispatch } from './workflow-fleet-dispatch'
import { launchWorkflowFleetSeats } from './workflow-fleet-seat-launch'
import { join } from 'node:path'
import { sweepGraphCheckLanes } from './graph/graph-check-lane-sweep'
import { sweepWorkflowContextFolders } from './context/context-sweep'
import { scheduleDiscoverToOmnios } from './discover-omnios-delivery'
import { reconcileDiscoverDeliveries } from './discover-omnios-reconcile'
import { AgentBudgetClient, resolveAgentBudgetConfig } from './agent-budget-client'
import { hostname } from 'node:os'

const hosts = new WeakMap<OrcaRuntimeService, Promise<LocalWorkflowHost>>()

export function getLocalWorkflowHost(runtime: OrcaRuntimeService): Promise<LocalWorkflowHost> {
  const existing = hosts.get(runtime)
  if (existing) {
    return existing
  }
  const pending = (async () => {
    const db = runtime.getOrchestrationDb().db
    const hostId = `local:${workflowEvidenceDigest(getAppEnvironment().getPath('userData'))}`
    const owner = await captureWorkflowOwner(hostId)
    // Once per app start; copies a live run of this process owns are kept.
    void sweepGraphCheckLanes()
    void sweepWorkflowContextFolders()
    // Off unless OMNI_AGENT_BUDGET_ENFORCE=true; never a local balance of its own.
    const budgetConfig = await resolveAgentBudgetConfig(process.env, hostname())
    const host = new LocalWorkflowHost({
      db,
      ...(budgetConfig ? { budgetAuthority: new AgentBudgetClient(budgetConfig) } : {}),
      working: { db: runtime.getOrchestrationDb(), runtime },
      owner,
      slots: new WorkflowScriptSlots(defaultWorkflowScriptSlots()),
      resolve: (request) =>
        runtime.resolveLocalWorkflowWorkspace(
          request.worktree,
          request.conversationId,
          'preset' in request ? request.preset : undefined
        ),
      catalog: () => catalog(runtime),
      refreshCapacity: () => refreshWorkflowCapacity(runtime),
      seatCapacity: () => workflowSeatCapacityNow(runtime),
      listScope: async (workspace) => listLocalWorkflowScope(workspace.path),
      freezeScope: async (workspace, ids) => {
        const frozen = await materializeLocalWorkflowScope(workspace.path, ids)
        if (frozen.refusals.length) {
          throw new Error(
            `Selected files changed: ${frozen.refusals.map((item) => item.id).join(', ')}`
          )
        }
        return {
          evidence: frozen.evidence,
          sources: frozen.sources.map((source) => ({ ref: source.id, description: source.label })),
          coverage: frozen.sources.map((source) => source.id)
        }
      },
      place: (runsOn, pick, excluded) => placeLocalWorkflow(runsOn, {}, pick, excluded),
      dispatch: (placement, snapshot) => readyWorkflowFleetDispatch(placement, snapshot),
      discardDispatch: discardWorkflowFleetDispatch,
      preflight: (snapshot) => preflight(runtime, snapshot),
      attestNativeResult,
      launch: (snapshot, executionId, fence, observer) =>
        snapshot.host.placement?.mode === 'dispatched-seats'
          ? launchWorkflowFleetSeats({
              snapshot,
              executionId,
              fence,
              hostId,
              ownerIncarnation: owner.spawnToken,
              directory: join(
                getAppEnvironment().getPath('userData'),
                'local-workflow-attempts',
                executionId
              ),
              observer
            })
          : launch(runtime, snapshot, executionId, fence, hostId, owner.spawnToken, observer),
      notify: (event) => runtime.notifyLocalWorkflowChanged(event),
      onSettled: (executionId, state, view) => {
        const row = db
          .prepare('SELECT snapshot_json FROM local_workflow_executions WHERE id=?')
          .get(executionId) as { snapshot_json: string } | undefined
        const placement =
          row &&
          (JSON.parse(row.snapshot_json).snapshot as LocalWorkflowHostSnapshot).host.placement
        if (placement && ['completed', 'cancelled'].includes(state)) {
          void finishWorkflowFleetDispatch(placement).catch((error) =>
            console.warn('[workflow]', error)
          )
        }
        if (state !== 'completed') {
          return
        }
        void scheduleDiscoverToOmnios(
          {
            db,
            view,
            runtime,
            root: join(getAppEnvironment().getPath('userData'), 'discover-omnios'),
            log: (line) => console.info(`[workflow] ${line}`)
          },
          executionId
        ).catch((error) => console.warn('[workflow] Discover to OmniOS failed:', error))
      }
    })
    let reconciling = false
    const sweep = async () => {
      if (reconciling) {
        return
      }
      reconciling = true
      try {
        await reconcileDiscoverDeliveries({
          db,
          runtime,
          view: async (id) => host.project(id),
          root: join(getAppEnvironment().getPath('userData'), 'discover-omnios'),
          log: (line) => console.info(`[workflow] ${line}`),
          publishEvolveDecision: (request) => runtime.publishArtifact(request)
        })
      } finally {
        reconciling = false
      }
    }
    const reconcile = () =>
      void sweep().catch((error) => console.warn('[workflow] Discover outbox:', error))
    reconcile()
    const timer = setInterval(reconcile, 120_000)
    timer.unref?.()
    return host
  })().catch((error) => {
    hosts.delete(runtime)
    throw error
  })
  hosts.set(runtime, pending)
  return pending
}
