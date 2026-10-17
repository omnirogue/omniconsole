import { z } from 'zod'
import { catalogModelsFromDiscovery } from './build-review-model-options'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'
import { NEXT_STEP_MAX_REVIEW_ROUNDS, NEXT_STEP_MAX_REVIEWERS } from './next-step-draft'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** Seats per plan: every agent step and every reviewer counts once, whatever its rounds. */
export const NEXT_OUTCOME_TEAM_MAX_AGENTS = 8
export const NEXT_OUTCOME_TEAM_LIMITS = {
  maxAgents: NEXT_OUTCOME_TEAM_MAX_AGENTS,
  maxReviewers: NEXT_STEP_MAX_REVIEWERS,
  maxRounds: NEXT_STEP_MAX_REVIEW_ROUNDS
} as const

const id = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/)
const model = z.string().trim().min(1).max(200)
const effort = z.string().trim().min(1).max(64).optional()
const instruction = z.string().trim().min(12).max(32_000)

export const nextOutcomeTeamActorSchema = z
  .object({ agent: z.custom<TuiAgent>(isTuiAgent), model, effort })
  .strict()

const agentStep = z
  .object({
    kind: z.literal('agent'),
    id,
    agent: z.custom<TuiAgent>(isTuiAgent),
    model,
    effort,
    instruction,
    scope: z.string().trim().min(1).max(4_000).optional(),
    parallelGroup: id.optional()
  })
  .strict()

const reviewStep = z
  .object({
    kind: z.literal('review'),
    id,
    reviewers: z.array(nextOutcomeTeamActorSchema).min(1).max(NEXT_STEP_MAX_REVIEWERS),
    maxRounds: z.number().int().min(1).max(NEXT_STEP_MAX_REVIEW_ROUNDS),
    instruction,
    adversarial: z.boolean().optional()
  })
  .strict()

export const nextOutcomeTeamPlanSchema = z
  .object({
    outcomes: z
      .array(
        z
          .object({
            outcomeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            steps: z
              .array(z.discriminatedUnion('kind', [agentStep, reviewStep]))
              .min(1)
              .max(NEXT_OUTCOME_TEAM_MAX_AGENTS)
          })
          .strict()
      )
      .min(1)
      .max(NEXT_OUTCOME_TEAM_MAX_AGENTS)
  })
  .strict()

export type NextOutcomeTeamPlan = z.infer<typeof nextOutcomeTeamPlanSchema>
export type NextOutcomeTeamStep = NextOutcomeTeamPlan['outcomes'][number]['steps'][number]
export type NextOutcomeTeamActor = z.infer<typeof nextOutcomeTeamActorSchema>

/** Consent recorded on the committed chain; absent means a user-authored (or no) plan. */
export type SessionChainTeamPlanning = {
  source: 'agent-planned'
  consentedAt: string
  committedAt: number
}

export type NextOutcomeTeamUsableModel = { id: string; label: string; efforts: string[] }
export type NextOutcomeTeamUsableAgent = { agent: TuiAgent; models: NextOutcomeTeamUsableModel[] }

/** Only probed models that this build can launch exactly; a static catalog guess is not usable. */
export function nextOutcomeTeamUsableModels(
  agent: TuiAgent,
  discovery:
    | {
        success: boolean
        catalogOrigin?: 'probe' | 'spec'
        models?: CommitMessageModelCapability[]
      }
    | null
    | undefined
): NextOutcomeTeamUsableModel[] {
  if (!discovery?.success || discovery.catalogOrigin !== 'probe' || !discovery.models) {
    return []
  }
  return catalogModelsFromDiscovery(agent, discovery.models)
    .filter((entry) => checkAgentLaunchPreferences(agent, { model: entry.id }).ok)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      efforts: entry.options.flatMap((option) =>
        option.id === 'effort' && option.kind.type === 'select'
          ? option.kind.choices
              .map((choice) => String(choice.value))
              .filter(
                (value) => checkAgentLaunchPreferences(agent, { model: entry.id, effort: value }).ok
              )
          : []
      )
    }))
}
