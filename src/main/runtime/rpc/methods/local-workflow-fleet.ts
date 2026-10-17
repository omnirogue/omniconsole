import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { LOCAL_WORKFLOW_METHODS } from '../../../../shared/local-workflow-rpc'
import { listWorkflowFleetHostOptions } from '../../workflow-script/local-workflow-fleet-placement'
import { localWorkflowRunStatus } from '../../workflow-script/local-workflow-run-status'
import {
  scheduleDiscoverToOmnios,
  discoverOmniosStatus
} from '../../workflow-script/discover-omnios-delivery'
import { getLocalWorkflowHost } from '../../workflow-script/local-workflow-runtime-host'
import { defineMethod, type RpcAnyMethod } from '../core'
import { assertLocalWorkflowCaller as localCaller } from './rpc-agent-caller'

/** Where workflows run: the hosts a person may name, and one run's placement and seats. */
export const LOCAL_WORKFLOW_FLEET_RPC_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.discoverDeliver,
    params: z.object({ executionId: z.string().uuid() }).strict(),
    handler: async (params, context) => {
      localCaller(context)
      const host = await getLocalWorkflowHost(context.runtime)
      return scheduleDiscoverToOmnios(
        {
          db: context.runtime.getOrchestrationDb().db,
          runtime: context.runtime,
          view: async () => host.project(params.executionId),
          root: join(getAppEnvironment().getPath('userData'), 'discover-omnios')
        },
        params.executionId
      )
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.runStatus,
    params: z.object({ executionId: z.string().uuid() }).strict(),
    // Read without recovering or resuming the run.
    handler: async (params, context) => {
      localCaller(context)
      const host = await getLocalWorkflowHost(context.runtime)
      const status = localWorkflowRunStatus(
        context.runtime.getOrchestrationDb().db,
        host.project(params.executionId)
      )
      const root = join(getAppEnvironment().getPath('userData'), 'discover-omnios')
      const omnios = discoverOmniosStatus(
        root,
        params.executionId,
        context.runtime.getOrchestrationDb().db
      )
      return omnios ? { ...status, omnios } : status
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.fleetHosts,
    params: z.object({}).strict(),
    // Names only: the reading is taken when a run starts, not when the form opens.
    handler: async (_params, context) => {
      localCaller(context)
      return await listWorkflowFleetHostOptions()
    }
  })
]
