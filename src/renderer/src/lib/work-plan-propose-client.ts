import { callRuntimeRpc } from '../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../runtime/runtime-client-target'
import type { ProposeWorkPlanResult } from '../../../shared/work-plan-propose-types'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { WorkPlanContext, WorkPlanOutcome } from '../../../shared/work-plan-types'

/**
 * Client side of `workPlan.propose`. Never throws: the RPC handler itself never throws to the
 * caller, and a transport failure here reads the same way the composer already handles it.
 */
export async function proposeWorkPlanViaRpc(
  target: RuntimeClientTarget,
  input: { text: string; outcome?: WorkPlanOutcome; ctx: WorkPlanContext; existingChain?: SessionChain }
): Promise<ProposeWorkPlanResult> {
  try {
    return await callRuntimeRpc<ProposeWorkPlanResult>(target, 'workPlan.propose', input)
  } catch {
    return { plan: null, reason: 'provider-unavailable' }
  }
}
