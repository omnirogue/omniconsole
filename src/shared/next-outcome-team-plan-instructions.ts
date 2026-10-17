import {
  hasNextOutcomeDiscovery,
  NEXT_OUTCOME_DISCOVERY_MARKER,
  nextOutcomeTeamPlanAgentInstructions
} from './next-outcome-intent-instructions'
import { NEXT_OUTCOME_TEAM_LIMITS } from './next-outcome-team-plan-schema'

const TEAM_PLAN_MARKER =
  /<!-- omni-team-plan-v1 consented-at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z) -->/

/** Joins a quoted instruction to its planner-written scope; the host splits on it to re-check authority. */
export const NEXT_OUTCOME_TEAM_SCOPE_LABEL = '\n\nTeam scope: '

/**
 * The user's "Plan the team" consent lives in the attested launch prompt itself, so an agent cannot
 * grant it: the host reads it back from the same submission that authorizes every quoted instruction.
 */
export function nextOutcomeTeamPlanConsent(
  prompt: string | undefined
): { consentedAt: string } | null {
  const match = prompt ? TEAM_PLAN_MARKER.exec(prompt) : null
  return match && !Number.isNaN(Date.parse(match[1]!)) ? { consentedAt: match[1]! } : null
}

export function nextOutcomeTeamPlanLaunchInstruction(cli: string, consentedAt: string): string {
  return `${NEXT_OUTCOME_DISCOVERY_MARKER}\n<!-- omni-team-plan-v1 consented-at=${consentedAt} -->\nThe user turned on "Plan the team" for the outcome below. Before implementing anything, run \`${cli} outcome context --json\` from this source terminal. It returns the usable agents with exact models, the team limits, and the instructions for committing the outcome with its team plan. Size the work first: how many implementer agents, whether they run in parallel on independent surfaces or in sequence, which cross-lineage reviewers and how many rounds, and the handoffs between them. Commit with \`${cli} outcome commit\`. Once the commit succeeds, do not implement the planned work yourself: report the plan in two lines and end your turn so the execution host can launch the team. If this host cannot bind the outcome or its plan, report the specific refusal and ask the user how to proceed.`
}

export function prependNextOutcomeTeamPlan(
  prompt: string,
  cli: string,
  consentedAt: string
): string {
  return !prompt.trim() || hasNextOutcomeDiscovery(prompt)
    ? prompt
    : `${nextOutcomeTeamPlanLaunchInstruction(cli, consentedAt)}\n\n${prompt}`
}

const TEAM_RULES = `Team plan: add \`team: {outcomes: [{outcomeId, steps}]}\` to the commit JSON, one entry per outcome the team works on. Steps run in order.
- \`{kind: "agent", id, agent, model, effort?, instruction, scope?, parallelGroup?}\` is one implementer session. Consecutive agent steps that share a parallelGroup are independent surfaces that run side by side, each in its own worktree; use sequence whenever one step needs another's result. An agent step placed directly after a review step is that review's repair agent between rounds.
- \`{kind: "review", id, reviewers: [{agent, model, effort?}], maxRounds, instruction, adversarial?}\` reviews the preceding implementer's result. Prefer reviewers from a different agent family than the implementers. A reviewer's model never equals any implementer's model in that outcome, and each reviewer uses a distinct model. To review against a rubric, begin the review instruction with a line "Rubric: <name>" for every reviewer, or one line "Rubric (reviewer N): <name>" per reviewer (N counts from 1), each followed by a blank line; names are General, Reliability, Design quality or Outcome. Put anything else after a line "Review focus:".
- Choose agents and exact model IDs only from teamPlanning.usableAgents; efforts must be listed for that model.
- Limits: at most ${NEXT_OUTCOME_TEAM_LIMITS.maxAgents} agents per plan (each agent step and each reviewer counts once), ${NEXT_OUTCOME_TEAM_LIMITS.maxReviewers} reviewers per review, ${NEXT_OUTCOME_TEAM_LIMITS.maxRounds} rounds.
- Every instruction is an exact excerpt (12+ characters) of the authorized prompt. scope narrows that excerpt to one surface (files, module, test suite); it cannot name external actions, destinations, or URLs.
- A team-planned outcome finishes complete or my-review, has empty actions and no stepIds. The host compiles the steps and their completion condition exactly as Next does, and records your plan with the user's consent.
- Plan the minimum team. One implementer with no reviewers is valid for small work.`

export const NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS =
  nextOutcomeTeamPlanAgentInstructions(TEAM_RULES)
