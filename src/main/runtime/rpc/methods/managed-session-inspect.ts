import { z } from 'zod'
import { parseAgentSessionOperationTimestamp } from '../../../../shared/agent-session-host-authority'
import { defineMethod } from '../core'

export const MANAGED_SESSION_INSPECT_METHOD = defineMethod({
  name: 'terminal.inspectAgentSessionLaunch',
  params: z
    .object({
      operationId: z.string().refine((value) => parseAgentSessionOperationTimestamp(value) !== null)
    })
    .strict(),
  handler: (params, context) => context.runtime.inspectAgentSessionLaunch(params.operationId)
})
