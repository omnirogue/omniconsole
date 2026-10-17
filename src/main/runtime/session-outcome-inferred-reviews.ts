import { compileNextStepChain } from '../../shared/next-step-compile'
import { emptyNextStepDraft, type NextStepOutcomeStep } from '../../shared/next-step-draft'
import { validateNextOutcomeReviewPlans } from '../../shared/next-outcome-review-plan'
import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'

/** Compile chat review requests into the same durable steps that Next edits and executes. */
export function appendInferredSessionReviews(args: {
  chain: SessionChain
  input: SessionOutcomeCommit
  previous: SessionChain | undefined
  authorityInstruction: string | undefined
}): { chain: SessionChain; input: SessionOutcomeCommit } {
  const { chain, input } = args
  if (!input.reviewPlans?.length) {
    return { chain, input }
  }
  if (
    input.source !== 'ai' ||
    !args.authorityInstruction ||
    input.expectedSourcePrompt !== args.authorityInstruction
  ) {
    throw new Error('Review inference requires the current attested source prompt.')
  }
  validateNextOutcomeReviewPlans({
    plans: input.reviewPlans,
    outcomes: input.outcomes,
    prompt: args.authorityInstruction,
    priorOutcomes: args.previous?.outcomeSet?.outcomes ?? []
  })
  const additions: SessionChainStep[] = []
  const outcomes = input.outcomes.map((outcome) => {
    const plans = input.reviewPlans!.filter((plan) => plan.outcomeId === outcome.id)
    if (!plans.length) {
      return outcome
    }
    const converted = new Set<string>()
    const reportTargets = new Map<string, string>()
    const addedStepIds: string[] = []
    for (const plan of plans) {
      const reviewers = plan.actionIds.map((id) =>
        outcome.actions.find((action) => action.id === id)!
      )
      const repair = outcome.actions.find((action) => action.id === plan.repairActionId)
      const configured: NextStepOutcomeStep[] = [
        {
          id: plan.id,
          kind: 'review',
          reviewers: reviewers.map(({ agent, model, effort, accountChoiceId }) => ({
            agent,
            model,
            effort,
            accountChoiceId
          })),
          maxRounds: plan.maxRounds ?? 1,
          instructions: reviewers[0]!.instruction,
          adversarial: plan.adversarial === true
        }
      ]
      if (repair) {
        const repairStep: Extract<NextStepOutcomeStep, { kind: 'handoff' }> & {
          reviewRepair: true
        } = {
          id: `${plan.id}_repair`,
          kind: 'handoff',
          actor: repair,
          presetId: 'improve',
          instructions: repair.instruction,
          reviewRepair: true
        }
        configured.push(repairStep)
      }
      const compiled = compileNextStepChain({
        draft: {
          ...emptyNextStepDraft(),
          outcomes: [
            { id: outcome.id, finish: { kind: 'complete' }, instructions: '', steps: configured }
          ]
        },
        chainId: chain.id,
        workspacePath: chain.workspacePath,
        sessionLabel: outcome.title,
        defaultNote: '',
        now: 0,
        mintStepId: () => {
          throw new Error('Review steps must use stable compiled IDs.')
        },
        mintOperationId: () => {
          throw new Error('Review plans cannot create person handoffs.')
        }
      })
      if (compiled.problems.length) {
        throw new Error('The inferred review plan could not be compiled.')
      }
      const firstRound = compiled.steps.filter(
        (step) => step.kind !== 'handoff' && step.review?.round === 1
      )
      reviewers.forEach((reviewer, index) => reportTargets.set(reviewer.id, firstRound[index]!.id))
      for (const step of compiled.steps) {
        if (
          chain.steps.some((existing) => existing.id === step.id) ||
          additions.some((existing) => existing.id === step.id)
        ) {
          throw new Error('This review already exists; preserve its committed steps and receipts.')
        }
        additions.push(step)
        addedStepIds.push(step.id)
      }
      for (const id of [...plan.actionIds, ...(plan.repairActionId ? [plan.repairActionId] : [])]) {
        converted.add(id)
      }
    }
    return {
      ...outcome,
      stepIds: [...(outcome.stepIds ?? []), ...addedStepIds],
      conditions: outcome.conditions.map((condition) =>
        condition.kind === 'report' && reportTargets.has(condition.target)
          ? { ...condition, target: reportTargets.get(condition.target)! }
          : condition
      ),
      actions: outcome.actions.filter((action) => !converted.has(action.id))
    }
  })
  return {
    chain: { ...chain, steps: [...chain.steps, ...additions] },
    input: { ...input, outcomes }
  }
}
