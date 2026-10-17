import { compileNextOutcomeTeamPlan } from '../../shared/next-outcome-team-plan-compile'
import { nextOutcomeTeamPlanConsent } from '../../shared/next-outcome-team-plan-instructions'
import {
  nextOutcomeTeamUsableModels,
  type NextOutcomeTeamUsableAgent
} from '../../shared/next-outcome-team-plan-schema'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import type { TuiAgent } from '../../shared/tui-agent'

export type SessionOutcomeTeamModelDiscovery = (
  worktreeSelector: string,
  agent: TuiAgent
) => Promise<Parameters<typeof nextOutcomeTeamUsableModels>[1]>

/**
 * Turn a source agent's team plan into the chain steps Next would compile. Consent is read from the
 * attested prompt, never from the caller, and models are checked against this host's live probes.
 */
export async function expandSessionOutcomeTeamPlan(args: {
  base: SessionChain
  input: SessionOutcomeCommit
  authorityInstruction?: string
  discover: SessionOutcomeTeamModelDiscovery
  now: number
}): Promise<{ base: SessionChain; input: SessionOutcomeCommit }> {
  const { base, input } = args
  const { teamPlanning: _callerClaim, ...unclaimed } = input
  if (!input.team) {
    return { base, input: unclaimed }
  }
  if (input.source !== 'ai') {
    throw new Error(
      'An agent-planned team is committed by its source agent; a person edits the plan under Next.'
    )
  }
  const consent = nextOutcomeTeamPlanConsent(args.authorityInstruction)
  if (!consent) {
    throw new Error(
      'Planning a team requires the "Plan the team" consent the user gave at launch. Commit the outcome without a team.'
    )
  }
  const agents = [
    ...new Set(
      input.team.outcomes.flatMap((entry) =>
        entry.steps.flatMap((step) =>
          step.kind === 'agent' ? [step.agent] : step.reviewers.map((reviewer) => reviewer.agent)
        )
      )
    )
  ]
  const selector = `id:${base.sourceWorktreeId ?? base.worktreeId}`
  const usable: NextOutcomeTeamUsableAgent[] = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      models: nextOutcomeTeamUsableModels(
        agent,
        await args.discover(selector, agent).catch(() => null)
      )
    }))
  )
  const planned = new Set(input.team.outcomes.map((entry) => entry.outcomeId))
  const compiled = compileNextOutcomeTeamPlan({
    team: input.team,
    outcomes: input.outcomes,
    chainId: base.id,
    workspacePath: base.workspacePath,
    sessionLabel: input.outcomes.find((outcome) => planned.has(outcome.id))?.title ?? base.id,
    usable
  })
  return {
    base: {
      ...base,
      steps: [
        ...base.steps.filter((step) => !step.outcomeId || !planned.has(step.outcomeId)),
        ...compiled.steps
      ]
    },
    input: {
      ...unclaimed,
      outcomes: compiled.outcomes,
      teamPlanning: {
        source: 'agent-planned',
        consentedAt: consent.consentedAt,
        committedAt: args.now
      }
    }
  }
}
