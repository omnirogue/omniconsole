import { z } from 'zod'
import {
  heuristicProposeWorkPlanDeps,
  proposeWorkPlan,
  type ProposeWorkPlanInput,
  type ProposeWorkPlanResult
} from '../../session-outcome-propose'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

/**
 * ctx/outcome/existingChain carry the composer's full WorkPlanContext/WorkPlanOutcome/
 * SessionChain shapes; they are validated by `workPlanProblems` (the one validator, same as a
 * user commit) rather than re-declared here, matching `sessionChain.commitOutcomes`'s
 * `chain: z.unknown()`.
 */
const WorkPlanPropose = z
  .object({
    text: requiredString('Missing text'),
    ctx: z.unknown(),
    outcome: z.unknown().optional(),
    existingChain: z.unknown().optional()
  })
  .strict()

export const WORK_PLAN_PROPOSE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'workPlan.propose',
    params: WorkPlanPropose,
    handler: async (params): Promise<ProposeWorkPlanResult> => {
      // Never throws to the renderer: a malformed ctx or a failed parse both read as
      // "the proposer is down", never as an RPC error that would surface as a banner.
      try {
        const input = params as unknown as ProposeWorkPlanInput
        return await proposeWorkPlan(input, heuristicProposeWorkPlanDeps())
      } catch {
        return { plan: null, reason: 'provider-unavailable' }
      }
    }
  })
]
