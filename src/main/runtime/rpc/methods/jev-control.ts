import { z } from 'zod'
import { JEV_CONTROL_METHODS, jevRequestSchema } from '../../../../shared/jev-control'
import { getStructuredDecisionRuntime } from '../../../structured-decisions/decision-runtime'
import { resolveTypesafeCredential } from '../../../structured-decisions/decision-credential'
import { defineMethod, type RpcMethod } from '../core'

export const JEV_CONTROL_RPC_METHODS: RpcMethod[] = [
  defineMethod({
    name: JEV_CONTROL_METHODS.status,
    params: z.object({}).strict(),
    handler: async (_params, { runtime }) => ({
      ...(await getStructuredDecisionRuntime(runtime).jev.status()),
      credentialConfigured: Boolean(await resolveTypesafeCredential().catch(() => undefined))
    })
  }),
  defineMethod({
    name: JEV_CONTROL_METHODS.configure,
    params: z.object({ enabled: z.boolean() }).strict(),
    handler: (params, { runtime }) =>
      getStructuredDecisionRuntime(runtime).jev.setEnabled(params.enabled)
  }),
  defineMethod({
    name: JEV_CONTROL_METHODS.request,
    params: jevRequestSchema,
    handler: async ({ input, control }, { runtime }) => {
      const decisions = getStructuredDecisionRuntime(runtime)
      const host = await decisions.jev.status()
      return decisions.request(input, {
        disabled: control === 'off' || host.effective === 'off',
        control
      })
    }
  })
]
