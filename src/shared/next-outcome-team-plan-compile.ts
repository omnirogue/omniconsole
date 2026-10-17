import { expandReviewRubricInstructions } from './review-rubrics'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'
import { compileNextStepOutcomes } from './next-outcome-definition-compile'
import { stripNextOutcomeOutputInstruction } from './next-outcome-compile'
import { nextOutcomeIntent } from './next-outcome-intent'
import {
  NEXT_OUTCOME_TEAM_SCOPE_LABEL,
  nextOutcomeTeamPlanConsent
} from './next-outcome-team-plan-instructions'
import {
  NEXT_OUTCOME_TEAM_MAX_AGENTS,
  type NextOutcomeTeamActor,
  type NextOutcomeTeamPlan,
  type NextOutcomeTeamUsableAgent
} from './next-outcome-team-plan-schema'
import { compileNextStepChain } from './next-step-compile'
import {
  nextStepOutcomeProblems,
  type NextStepActor,
  type NextStepDraft,
  type NextStepOutcomeDraft
} from './next-step-draft'
import type { SessionChainStep } from './session-chain-types'
import { sessionOutcomeConditionKey, type SessionOutcomeDefinition } from './session-outcome-types'

export function nextOutcomeTeamStepPrompt(step: { instruction: string; scope?: string }): string {
  return step.scope
    ? `${step.instruction}${NEXT_OUTCOME_TEAM_SCOPE_LABEL}${step.scope}`
    : step.instruction
}

function actor(entry: NextOutcomeTeamActor): NextStepActor {
  return {
    agent: entry.agent,
    model: entry.model,
    ...(entry.effort ? { effort: entry.effort } : {})
  }
}

const actorKey = (entry: NextOutcomeTeamActor): string => `${entry.agent}:${entry.model}`

/** The Next dialog draft an agent-planned team stands for; both compile through the same path. */
export function nextOutcomeTeamDrafts(
  team: NextOutcomeTeamPlan,
  outcomes: readonly SessionOutcomeDefinition[]
): NextStepOutcomeDraft[] {
  return team.outcomes.map((entry) => ({
    id: entry.outcomeId,
    finish: {
      kind:
        outcomes.find((outcome) => outcome.id === entry.outcomeId)?.finish === 'my-review'
          ? 'my-review'
          : 'complete'
    },
    instructions: '',
    steps: entry.steps.map((step, index) => {
      const previous = entry.steps[index - 1]
      const next = entry.steps[index + 1]
      // Why: a review of more than one round only repeats if someone repairs the blocking findings
      // between rounds. The plan says who: the agent seat placed right after the review, or —
      // when the planner asked for no such seat — the producer that wrote the work.
      return step.kind === 'agent'
        ? {
            id: step.id,
            kind: 'handoff' as const,
            actor: actor(step),
            presetId: previous?.kind === 'review' ? 'improve' : 'implement',
            instructions: nextOutcomeTeamStepPrompt(step),
            ...(step.parallelGroup ? { parallelGroup: step.parallelGroup } : {}),
            ...(previous?.kind === 'review' && previous.maxRounds > 1 ? { reviewRepair: true } : {})
          }
        : {
            id: step.id,
            kind: 'review' as const,
            reviewers: step.reviewers.map(actor),
            maxRounds: step.maxRounds,
            instructions: expandReviewRubricInstructions(step.instruction),
            adversarial: step.adversarial === true,
            ...(step.maxRounds > 1 && next?.kind !== 'agent' ? { repairWithSource: true } : {})
          }
    })
  }))
}

function assertActor(entry: NextOutcomeTeamActor, usable?: readonly NextOutcomeTeamUsableAgent[]) {
  const checked = checkAgentLaunchPreferences(entry.agent, {
    model: entry.model,
    ...(entry.effort ? { effort: entry.effort } : {})
  })
  if (!checked.ok) {
    throw new Error(checked.message)
  }
  if (!usable) {
    return
  }
  const model = usable
    .find((candidate) => candidate.agent === entry.agent)
    ?.models.find((candidate) => candidate.id === entry.model)
  if (!model || (entry.effort && !model.efforts.includes(entry.effort))) {
    throw new Error(
      `${entry.agent} ${entry.model}${entry.effort ? ` at ${entry.effort}` : ''} is not usable on this host. Choose from teamPlanning.usableAgents in outcome context.`
    )
  }
}

/** Structural limits every agent-planned team obeys; `usable` adds the host's exact live models. */
export function assertNextOutcomeTeamPlan(
  team: NextOutcomeTeamPlan,
  outcomes: readonly SessionOutcomeDefinition[],
  usable?: readonly NextOutcomeTeamUsableAgent[]
): void {
  const seen = new Set<string>()
  let seats = 0
  for (const entry of team.outcomes) {
    const outcome = outcomes.find((candidate) => candidate.id === entry.outcomeId)
    if (!outcome || seen.has(entry.outcomeId)) {
      throw new Error('Each team plan names one submitted outcome exactly once.')
    }
    seen.add(entry.outcomeId)
    if (!['complete', 'my-review'].includes(outcome.finish) || outcome.actions.length) {
      throw new Error(
        'A team-planned outcome finishes complete or my-review and carries its work in team steps, not actions.'
      )
    }
    if (outcome.stepIds) {
      throw new Error('The host assigns step IDs for a team-planned outcome; omit stepIds.')
    }
    if (new Set(entry.steps.map((step) => step.id)).size !== entry.steps.length) {
      throw new Error('Team step IDs must be unique within an outcome.')
    }
    const implementers = entry.steps.flatMap((step) => (step.kind === 'agent' ? [step] : []))
    for (const group of new Set(implementers.flatMap((step) => step.parallelGroup ?? []))) {
      const at = entry.steps.flatMap((step, index) =>
        step.kind === 'agent' && step.parallelGroup === group ? [index] : []
      )
      if (at.length < 2 || at.at(-1)! - at[0]! + 1 !== at.length) {
        throw new Error('A parallel group needs two or more consecutive agent steps.')
      }
      if (entry.steps[at[0]! - 1]?.kind === 'review') {
        throw new Error(
          'The agent step after a review is its repair agent and cannot start a parallel group.'
        )
      }
    }
    for (const step of entry.steps) {
      if (step.kind === 'agent') {
        seats += 1
        assertActor(step, usable)
        if (step.scope && nextOutcomeIntent(step.scope).kind === 'unsupported') {
          throw new Error(
            'A team scope narrows the quoted work; it cannot name external actions, destinations, or URLs.'
          )
        }
        continue
      }
      seats += step.reviewers.length
      const keys = step.reviewers.map(actorKey)
      if (new Set(keys).size !== keys.length) {
        throw new Error('Each reviewer needs a distinct model.')
      }
      if (keys.some((key) => implementers.some((writer) => actorKey(writer) === key))) {
        throw new Error('A reviewer must never use the same model as an implementer it reviews.')
      }
      step.reviewers.forEach((reviewer) => assertActor(reviewer, usable))
    }
  }
  if (seats > NEXT_OUTCOME_TEAM_MAX_AGENTS) {
    throw new Error(`A team plan is limited to ${NEXT_OUTCOME_TEAM_MAX_AGENTS} agents.`)
  }
  const problems = nextStepOutcomeProblems(nextOutcomeTeamDrafts(team, outcomes))
  if (problems.length) {
    throw new Error(problems[0])
  }
}

/** Compile an agent-planned team into chain steps and completion conditions exactly as Next does. */
export function compileNextOutcomeTeamPlan(args: {
  team: NextOutcomeTeamPlan
  outcomes: readonly SessionOutcomeDefinition[]
  chainId: string
  workspacePath: string
  sessionLabel: string
  usable?: readonly NextOutcomeTeamUsableAgent[]
}): { steps: SessionChainStep[]; outcomes: SessionOutcomeDefinition[] } {
  assertNextOutcomeTeamPlan(args.team, args.outcomes, args.usable)
  const drafts = nextOutcomeTeamDrafts(args.team, args.outcomes)
  const draft: NextStepDraft = {
    end: 'done',
    placement: null,
    recipients: [],
    note: '',
    after: [],
    handoff: { task: null, deliverables: null, includeSummary: false },
    outcomes: drafts
  }
  const compiled = compileNextStepChain({
    draft,
    chainId: args.chainId,
    workspacePath: args.workspacePath,
    sessionLabel: args.sessionLabel,
    defaultNote: args.sessionLabel,
    now: 0,
    mintStepId: (position) => `team_step_${position}`,
    mintOperationId: () => 'team_operation',
    cardlessHandoffs: true
  })
  if (compiled.problems.length) {
    throw new Error('The team plan is incomplete.')
  }
  const firstActor = args.team.outcomes[0]!.steps[0]!
  const definitions = compileNextStepOutcomes(drafts, {
    chainId: args.chainId,
    workspacePath: args.workspacePath,
    sessionLabel: args.sessionLabel,
    fallbackActor: actor(firstActor.kind === 'agent' ? firstActor : firstActor.reviewers[0]!),
    steps: compiled.steps
  })
  const outcomes = args.outcomes.map((outcome) => {
    const derived = definitions.find((entry) => entry.id === outcome.id)
    if (!derived) {
      return outcome
    }
    const conditions = [...outcome.conditions]
    for (const condition of derived.conditions) {
      const existing = conditions.find((entry) => entry.id === condition.id)
      if (!existing) {
        conditions.push(condition)
      } else if (sessionOutcomeConditionKey(existing) !== sessionOutcomeConditionKey(condition)) {
        throw new Error(
          `Condition ID ${condition.id} is reserved for the team's completion evidence.`
        )
      }
    }
    return { ...outcome, stepIds: derived.stepIds ?? [], conditions }
  })
  return { steps: compiled.steps, outcomes }
}

/** A team step is authorized only by user consent plus an exact quote; its scope may narrow, never add. */
export function nextOutcomeTeamStepAuthorized(
  step: SessionChainStep,
  chain: { id: string; workspacePath: string },
  authority: string | undefined
): boolean {
  if (!authority || !nextOutcomeTeamPlanConsent(authority) || step.kind === 'handoff') {
    return false
  }
  const prompt = step.review
    ? step.prompt
    : stripNextOutcomeOutputInstruction(step.prompt, chain.workspacePath, chain.id, step.id)
  const at = prompt.indexOf(NEXT_OUTCOME_TEAM_SCOPE_LABEL)
  const quote = at === -1 ? prompt : prompt.slice(0, at)
  const scope = at === -1 ? '' : prompt.slice(at + NEXT_OUTCOME_TEAM_SCOPE_LABEL.length)
  return (
    quote.trim().length >= 12 &&
    authority.includes(quote) &&
    (!scope || nextOutcomeIntent(scope).kind !== 'unsupported')
  )
}
