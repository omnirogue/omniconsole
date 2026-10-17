import { z } from 'zod'
import {
  EVOLVE_RPC,
  EVOLVE_RUN_ID_PATTERN,
  evolveStartRequestSchema
} from '../../../../shared/evolve-workflow'
import { getEvolveService } from '../../evolve/evolve-service-registry'
import { defineMethod, type RpcMethod } from '../core'
import {
  assertAgentWorkflowLaunch,
  assertLocalWorkflowCaller,
  isAgentRpcCaller
} from './rpc-agent-caller'

const IdParams = z.object({
  id: z.string().regex(EVOLVE_RUN_ID_PATTERN, 'An Evolve run id: evo_…')
})

/** Evolve runs (docs/reference/evolve-workflow.md): started here, executed on a fleet host. */
export const EVOLVE_METHODS: RpcMethod[] = [
  defineMethod({
    name: EVOLVE_RPC.start,
    params: evolveStartRequestSchema,
    handler: async (params, context) => {
      assertLocalWorkflowCaller(context)
      assertAgentWorkflowLaunch(context, 'evolve', params)
      const run = await getEvolveService(context.runtime).start(params, {
        agent: isAgentRpcCaller(context)
      })
      return { run }
    }
  }),
  defineMethod({
    name: EVOLVE_RPC.list,
    params: null,
    handler: (_params, { runtime }) => ({ runs: getEvolveService(runtime).list() })
  }),
  defineMethod({
    name: EVOLVE_RPC.show,
    params: IdParams,
    handler: (params, { runtime }) => ({ run: getEvolveService(runtime).show(params.id) })
  }),
  defineMethod({
    name: EVOLVE_RPC.refresh,
    params: IdParams,
    handler: async (params, { runtime }) => ({
      run: await getEvolveService(runtime).refresh(params.id)
    })
  }),
  defineMethod({
    name: EVOLVE_RPC.stop,
    params: IdParams,
    handler: async (params, context) => {
      assertLocalWorkflowCaller(context)
      return { run: await getEvolveService(context.runtime).stop(params.id) }
    }
  })
]
