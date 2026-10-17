import { z } from 'zod'
import {
  acceptWorkingAgentResult,
  getWorkingAgentCallForDispatch
} from '../../workflow-script/workflow-working-agent-calls'
import { captureWorkingAgentDispatchArtifacts } from '../../workflow-script/workflow-working-agent-dispatch-artifacts'
import { anonymousCandidatePacket } from '../../workflow-script/workflow-working-artifacts'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { requireWorkflowResultWorker } from './orchestration-workflow-result-authority'

const ResultSubmitParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  from: requiredString('Missing --from'),
  result: z.unknown()
})

export const ORCHESTRATION_WORKFLOW_RESULT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.resultSubmit',
    params: ResultSubmitParams,
    handler: async (params, context) => {
      if (context.pairedDeviceId || context.clientKind === 'mobile') {
        throw new OrchestrationError(
          'dispatch_capability_invalid',
          'A workflow result must come from its assigned desktop worker.'
        )
      }
      const encoded = JSON.stringify(params.result)
      if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) {
        throw new OrchestrationError('invalid_argument', 'Workflow result exceeds 256 KiB.')
      }
      const db = requireWorkflowResultWorker(context.runtime, {
        dispatchId: params.dispatch,
        from: params.from,
        capability: context.orchestrationCapability,
        callerEvidence: context.orchestrationCompatibilityEvidence
      })
      const call = getWorkingAgentCallForDispatch(db, params.dispatch)
      if (!call) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'The active Dispatch is not bound to a workflow call.'
        )
      }
      let artifacts
      try {
        artifacts = await captureWorkingAgentDispatchArtifacts(db, params.dispatch)
        if (call.call_id.startsWith('answers/') && artifacts) {
          // The actual anonymous label is assigned by the Council program; this checks
          // the candidate and files for identifying metadata before the worker can finish.
          anonymousCandidatePacket(params.result, artifacts, 'Response A')
        }
      } catch (error) {
        return {
          accepted: false,
          problems: error instanceof Error ? error.message : 'Candidate artifact validation failed'
        }
      }
      return acceptWorkingAgentResult(db, params.dispatch, params.result, artifacts?.digest)
    }
  })
]
