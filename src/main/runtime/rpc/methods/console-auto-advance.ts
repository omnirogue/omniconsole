import { z } from 'zod'
import {
  CONSOLE_AUTO_ADVANCE_RPC,
  isConsoleAutoAdvanceWorkflowId,
  isConsoleAutoAdvanceWorktree
} from '../../../../shared/console-auto-advance'
import {
  getConsoleAutoAdvanceService,
  readConsoleAutoAdvance,
  writeConsoleAutoAdvance
} from '../../../console-workflows/console-auto-advance-service'
import { defineMethod, type RpcMethod } from '../core'

const WorkflowParams = z.object({
  workflowId: z.string().refine(isConsoleAutoAdvanceWorkflowId, 'Missing admitted workflow id')
})
const SetParams = WorkflowParams.extend({
  enabled: z.boolean(),
  worktree: z.string().refine(isConsoleAutoAdvanceWorktree, 'Missing workspace selector').optional()
})

/**
 * Person preference for auto-advance plus one explicit decision cycle. No method here names a
 * job: the runner may only activate a ready local job the person's own workflow already contains.
 */
export const CONSOLE_AUTO_ADVANCE_METHODS: RpcMethod[] = [
  defineMethod({
    name: CONSOLE_AUTO_ADVANCE_RPC.get,
    params: WorkflowParams,
    handler: (params, { runtime }) => ({
      preference: readConsoleAutoAdvance(runtime, params.workflowId)
    })
  }),
  defineMethod({
    name: CONSOLE_AUTO_ADVANCE_RPC.set,
    params: SetParams,
    handler: (params, { runtime }) => ({ preference: writeConsoleAutoAdvance(runtime, params) })
  }),
  defineMethod({
    name: CONSOLE_AUTO_ADVANCE_RPC.run,
    params: WorkflowParams,
    handler: async (params, { runtime }) => ({
      status: await getConsoleAutoAdvanceService(runtime).cycle(params.workflowId),
      preference: readConsoleAutoAdvance(runtime, params.workflowId)
    })
  })
]
