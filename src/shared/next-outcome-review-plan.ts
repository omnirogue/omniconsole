import { z } from 'zod'
import { NEXT_STEP_MAX_REVIEWERS, NEXT_STEP_MAX_REVIEW_ROUNDS } from './next-step-draft'
import type { SessionOutcomeDefinition } from './session-outcome-types'
import { nextOutcomeIntent } from './next-outcome-intent'
import { isDirectSourceInstructionQuote } from './source-instruction-evidence'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/)
export const nextOutcomeReviewPlanSchema = z
  .object({
    id,
    outcomeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    actionIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/))
      .min(1)
      .max(NEXT_STEP_MAX_REVIEWERS),
    maxRounds: z.number().int().min(1).max(NEXT_STEP_MAX_REVIEW_ROUNDS).optional(),
    repairActionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    adversarial: z.boolean().optional()
  })
  .strict()

export type NextOutcomeReviewPlan = z.infer<typeof nextOutcomeReviewPlanSchema>

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five']
const REVIEW = /\breview(?:er|ers|ing)?\b/i
const NEGATED_REVIEW =
  /\b(?:do not|don['’]t|never|without|no)\b[^.!?;\n]{0,80}\breview(?:er|ers|ing)?\b/i

function explicitCount(
  instruction: string,
  count: number,
  kind: 'reviewers' | 'rounds',
  agents: readonly string[] = []
): boolean {
  const noun = kind === 'reviewers' ? 'agents?|reviewers?' : 'rounds?'
  const modifiers =
    kind === 'reviewers'
      ? ['independent', 'separate', 'parallel', 'AI', ...agents]
      : ['review', 'adversarial']
  return new RegExp(
    `\\b(?:${count}|${NUMBER_WORDS[count]})\\s+(?:(?:${modifiers.join('|')})\\s+){0,3}(?:${noun})\\b`,
    'i'
  ).test(instruction)
}

function mentionsAgent(instruction: string, agent: string): boolean {
  return new RegExp(`\\b${agent.replaceAll('-', '[ -]')}\\b`, 'i').test(instruction)
}

/** The agent proposes structure; only exact source instructions authorize its expansion. */
export function validateNextOutcomeReviewPlans(args: {
  plans: readonly NextOutcomeReviewPlan[]
  outcomes: readonly SessionOutcomeDefinition[]
  prompt: string
  priorOutcomes: readonly SessionOutcomeDefinition[]
}): void {
  const consumed = new Set<string>()
  const planIds = new Set<string>()
  for (const plan of args.plans) {
    if (planIds.has(plan.id)) {
      throw new Error('Each inferred review plan needs a unique ID.')
    }
    planIds.add(plan.id)
    const outcome = args.outcomes.find((entry) => entry.id === plan.outcomeId)
    if (!outcome) {
      throw new Error('The review plan must name an outcome in this submission.')
    }
    const actions = [...plan.actionIds, ...(plan.repairActionId ? [plan.repairActionId] : [])].map(
      (actionId) => {
        const key = `${outcome.id}:${actionId}`
        const action = outcome.actions.find((entry) => entry.id === actionId)
        if (!action || consumed.has(key)) {
          throw new Error('Each review or repair action must occur in exactly one review plan.')
        }
        consumed.add(key)
        if (
          args.priorOutcomes.some(
            (entry) =>
              entry.id === outcome.id && entry.actions.some((prior) => prior.id === actionId)
          )
        ) {
          throw new Error('Keep committed actions unchanged; add a new review plan for new work.')
        }
        if (
          action.instruction.length < 12 ||
          !isDirectSourceInstructionQuote(action.instruction, args.prompt)
        ) {
          throw new Error('Each review and repair action must quote the attested source prompt.')
        }
        if (nextOutcomeIntent(action.instruction).kind === 'unsupported') {
          throw new Error(
            'Keep review and repair quotes separate from delivery or publication actions.'
          )
        }
        return action
      }
    )
    const reviewers = actions.slice(0, plan.actionIds.length)
    const instruction = reviewers[0]!.instruction
    if (
      !REVIEW.test(instruction) ||
      NEGATED_REVIEW.test(instruction) ||
      reviewers.some((action) => action.instruction !== instruction)
    ) {
      throw new Error('A review group needs one shared, affirmative review request quoted exactly.')
    }
    if (reviewers.some((action) => !mentionsAgent(instruction, action.agent))) {
      throw new Error(
        'The review request must name each selected agent; ask when the agent is ambiguous.'
      )
    }
    if (
      reviewers.length > 1 &&
      !explicitCount(
        instruction,
        reviewers.length,
        'reviewers',
        reviewers.map((action) => action.agent)
      ) &&
      new Set(reviewers.map((action) => action.agent)).size !== reviewers.length
    ) {
      throw new Error('Additional reviewers require an explicit count or separately named agents.')
    }
    for (const reviewer of reviewers) {
      if (
        !outcome.conditions.some(
          (condition) =>
            condition.kind === 'report' &&
            condition.target === reviewer.id &&
            reviewer.conditionIds.includes(condition.id)
        )
      ) {
        throw new Error('Each reviewer needs a report condition targeting its action ID.')
      }
      if (
        outcome.conditions.some(
          (condition) =>
            condition.kind === 'report' &&
            condition.target === reviewer.id &&
            args.priorOutcomes.some(
              (prior) =>
                prior.id === outcome.id &&
                prior.conditions.some((entry) => entry.id === condition.id)
            )
        )
      ) {
        throw new Error('New review reports cannot replace committed evidence conditions.')
      }
    }
    const maxRounds = plan.maxRounds ?? 1
    if (maxRounds > 1 && !explicitCount(instruction, maxRounds, 'rounds')) {
      throw new Error('Additional review rounds must be explicitly requested in the review quote.')
    }
    if (maxRounds > 1 && !plan.repairActionId) {
      throw new Error(
        'Multiple review rounds need an explicitly requested repair action between rounds.'
      )
    }
    if (plan.repairActionId) {
      const repair = actions.at(-1)!
      if (
        maxRounds === 1 ||
        !/\b(?:fix|repair|revise|address)\b/i.test(repair.instruction) ||
        /\b(?:do not|don['’]t|never|without|no)\b[^.!?;\n]{0,80}\b(?:fix|repair|revise|address)\b/i.test(
          repair.instruction
        ) ||
        !mentionsAgent(repair.instruction, repair.agent)
      ) {
        throw new Error(
          'A repair action must name the agent and requested repair between review rounds.'
        )
      }
    }
    if (plan.adversarial && !/\badversarial\b/i.test(instruction)) {
      throw new Error('Adversarial review must be explicitly requested.')
    }
  }
}
