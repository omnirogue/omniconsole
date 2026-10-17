import type { SessionChain } from './session-chain-types'
import type { WorkPlan, WorkPlanContext, WorkPlanProblem } from './work-plan-types'

/**
 * The wire shape of `workPlan.propose`, shared by the main-process proposer
 * (`src/main/runtime/session-outcome-propose.ts`) and the renderer client/banner so the
 * renderer never imports across the main/renderer boundary for a type alone.
 */
export type ProposeWorkPlanInput = {
  text: string
  outcome?: WorkPlan['outcome']
  ctx: WorkPlanContext
  existingChain?: SessionChain
}

export type ProposeWorkPlanReason =
  | 'no-pursuit'
  | 'unusable-agents'
  | 'invalid'
  | 'provider-unavailable'

export type ProposeWorkPlanResult =
  | { plan: WorkPlan; sentence: string }
  | { plan: null; reason: ProposeWorkPlanReason; problems?: WorkPlanProblem[] }
