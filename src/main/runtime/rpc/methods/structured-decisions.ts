import { z } from 'zod'
import { jevTrialInputSchema } from '../../../../shared/jev-control'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { ExpectedOwner } from './automation-schemas'
import { getStructuredDecisionRuntime } from '../../../structured-decisions/decision-runtime'
import { evaluateJevTrialWorkflow } from '../../../structured-decisions/jev-trial-workflow'
import { isAgentRpcCaller } from './rpc-agent-caller'

const runRequest = z
  .object({
    automationId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    expectedOwner: ExpectedOwner
  })
  .strict()
const actionRequest = runRequest.extend({
  decisionId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedOwner: ExpectedOwner.unwrap()
})
const jevTrialRequest = jevTrialInputSchema

function owned(params: z.infer<typeof runRequest>, context: RpcContext) {
  const automation = context.runtime.showAutomation(params.automationId, params.expectedOwner)
  const owner = context.runtime.automationOwnerPrecondition(params.automationId)
  if (automation.executionTargetType !== 'local' || owner?.selector.kind !== 'self') {
    throw new Error('Request structured decisions from the routine execution host.')
  }
  return getStructuredDecisionRuntime(context.runtime)
}

export const STRUCTURED_DECISION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'structuredDecision.jevTrial',
    params: jevTrialRequest,
    handler: async (params, context) => {
      if (
        context.clientId !== 'desktop-renderer' ||
        context.clientKind !== 'runtime' ||
        !context.connectionId?.startsWith('desktop-renderer:') ||
        context.pairedDeviceId ||
        isAgentRpcCaller(context)
      ) {
        throw new Error('JEV trial workflows require this desktop runtime.')
      }
      // Why: like `jev request` and rubric evaluations, the host switch is read before any call,
      // so a refused trial is recorded as not_called; the result is the same `disabled`.
      const host = await getStructuredDecisionRuntime(context.runtime).jev.status()
      return evaluateJevTrialWorkflow(params.recipeId, params.state, {
        disabled: host.effective === 'off'
      })
    }
  }),
  defineMethod({
    name: 'structuredDecision.status',
    params: z.object({}).strict(),
    handler: (_params, { runtime }) => getStructuredDecisionRuntime(runtime).status()
  }),
  defineMethod({
    name: 'structuredDecision.disable',
    params: z.object({}).strict(),
    handler: (_params, { runtime }) => getStructuredDecisionRuntime(runtime).disable()
  }),
  defineMethod({
    name: 'automation.structured.get',
    params: runRequest,
    handler: async (params, context) => {
      const result = await owned(params, context).routines.classification(
        params.automationId,
        params.runId
      )
      owned(params, context)
      return { result }
    }
  }),
  defineMethod({
    name: 'automation.advertising.get',
    params: runRequest,
    handler: async (params, context) => {
      const envelope = await owned(params, context).routines.advertising(
        params.automationId,
        params.runId
      )
      owned(params, context)
      return { envelope }
    }
  }),
  defineMethod({
    name: 'automation.advertising.preview',
    params: actionRequest,
    handler: (params, context) =>
      owned(params, context).routines.actions.preview(params, () => {
        owned(params, context)
      })
  }),
  defineMethod({
    name: 'automation.advertising.execute',
    params: actionRequest.extend({
      previewId: z.string().regex(/^act_[a-f0-9]{32}$/),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      approved: z.literal(true)
    }),
    handler: (params, context) =>
      owned(params, context).routines.actions.execute(params, () => {
        owned(params, context)
      })
  }),
  defineMethod({
    name: 'automation.advertising.verify',
    params: actionRequest,
    handler: (params, context) =>
      owned(params, context).routines.actions.verify(params, () => {
        owned(params, context)
      })
  })
]
