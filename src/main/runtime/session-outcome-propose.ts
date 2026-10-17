import { heuristicParse, looksLikePursuit } from './session-outcome-propose-heuristic'
import { workPlanSentence } from '../../shared/work-plan-sentence'
import { workPlanProblems } from '../../shared/work-plan-validate'
import type {
  ProposeWorkPlanInput,
  ProposeWorkPlanReason,
  ProposeWorkPlanResult
} from '../../shared/work-plan-propose-types'
import type { WorkPlan, WorkPlanContext } from '../../shared/work-plan-types'

export type { ProposeWorkPlanInput, ProposeWorkPlanReason, ProposeWorkPlanResult }

/**
 * "3 researchers then synthesize, 3 planners, a judge picks, the winner improves, two
 * reviewers, then me" is a described workflow, not a question: this module turns it into the
 * SAME WorkPlan object the composer builds and edits. A question or discussion about the
 * workflow ("What is the recommended next action after a Best-of-N judge?") describes nothing
 * to run and must never be read as one -- see `looksLikePursuit` (session-outcome-propose-
 * heuristic.ts), which also holds the deterministic parse itself.
 */

/**
 * The seam the model is called through. Production wires a real parse; tests inject a fake so
 * the refusal/validation logic below is exercised without a live provider. See the PR body for
 * why no existing one-shot provider client is reused here (none exists outside the
 * source-control text-generation package, which WP-11 does not own).
 */
export type ProposeWorkPlanDeps = {
  parse(text: string, ctx: WorkPlanContext): Promise<WorkPlan | null>
}

export async function proposeWorkPlan(
  input: ProposeWorkPlanInput,
  deps: ProposeWorkPlanDeps
): Promise<ProposeWorkPlanResult> {
  if (!looksLikePursuit(input.text)) {
    return { plan: null, reason: 'no-pursuit' }
  }
  let parsed: WorkPlan | null
  try {
    parsed = await deps.parse(input.text, input.ctx)
  } catch {
    return { plan: null, reason: 'provider-unavailable' }
  }
  if (!parsed) {
    return { plan: null, reason: 'no-pursuit' }
  }
  const plan: WorkPlan = {
    ...parsed,
    outcome: input.outcome ? { ...parsed.outcome, ...input.outcome } : parsed.outcome,
    source: input.existingChain ? { conversationId: input.existingChain.id } : parsed.source
  }
  const problems = workPlanProblems(plan, { ...input.ctx, commitSource: 'proposer' })
  const blocks = problems.filter((problem) => problem.severity === 'block')
  if (blocks.length > 0) {
    const reason: ProposeWorkPlanReason = blocks.some(
      (problem) => problem.code === 'actor-not-usable'
    )
      ? 'unusable-agents'
      : 'invalid'
    return { plan: null, reason, problems: blocks }
  }
  return { plan, sentence: workPlanSentence(plan) }
}

/**
 * Production default for `ProposeWorkPlanDeps.parse`. No standalone one-shot LLM completion
 * client exists on this tip outside `src/main/text-generation` (owned by the source-control
 * package; its `SourceControlAiOperation` union does not carry a work-plan operation and
 * extending it is out of WP-11's ownership). This heuristic keeps the seam real and testable
 * without a second LLM client; see the PR body for the wiring gap this leaves for the owner of
 * a general-purpose provider call to close.
 */
export function heuristicProposeWorkPlanDeps(): ProposeWorkPlanDeps {
  return {
    async parse(text, ctx) {
      return heuristicParse(text, ctx, text.trim().slice(0, 200))
    }
  }
}
