import { createHash } from 'node:crypto'
import { nextOutcomeOutputInstruction } from '../../shared/next-outcome-compile'
import { NEXT_STEP_MAX_REVIEW_ROUNDS, type NextStepActor } from '../../shared/next-step-draft'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'

export class SessionOutcomeSourceRepairActorError extends Error {}

function sourceRepairActor(
  chain: SessionChain,
  reviewer: SessionChainAgentStep,
  sourceActor?: NextStepActor
): NextStepActor {
  const producer = chain.steps
    .slice(0, chain.steps.indexOf(reviewer))
    .findLast(
      (step): step is SessionChainAgentStep =>
        step.kind !== 'handoff' &&
        (step.planVersion ?? 1) === (reviewer.planVersion ?? 1) &&
        Boolean(reviewer.outcomeId) &&
        step.outcomeId === reviewer.outcomeId &&
        !step.review &&
        !step.reviewRepair
    )
  const actor = producer ?? sourceActor
  if (!actor) {
    throw new SessionOutcomeSourceRepairActorError(
      'The original source agent could not be verified. Wait for its completion before starting repeated review rounds.'
    )
  }
  return {
    agent: actor.agent,
    ...(actor.model !== undefined ? { model: actor.model } : {}),
    ...(actor.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...actor.openrouterCandidates] }
      : {}),
    ...(actor.effort !== undefined ? { effort: actor.effort } : {}),
    ...(actor.accountChoiceId !== undefined ? { accountChoiceId: actor.accountChoiceId } : {})
  }
}

function sourceRepairStep(
  chain: SessionChain,
  reviewer: SessionChainAgentStep,
  actor: NextStepActor
): SessionChainAgentStep {
  const review = reviewer.review!
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        chain.id,
        review.groupId,
        review.round,
        ...((chain.planVersion ?? 1) > 1 ? [chain.planVersion] : [])
      ])
    )
    .digest('hex')
    .slice(0, 32)
  const id = `source_repair_${digest}_round_${review.round}`
  return {
    id,
    ...actor,
    outcomeId: reviewer.outcomeId,
    ...(reviewer.planVersion ? { planVersion: reviewer.planVersion } : {}),
    editorStepId: reviewer.editorStepId,
    presetId: 'improve',
    status: 'queued',
    prompt: [
      'Continue the original task using the completed source work. Repair only the documented blocking findings from the immediately preceding review round. Stay within the original task and its existing authority, preserve unaffected work, and report each addressed blocker and its verification.',
      nextOutcomeOutputInstruction(chain.workspacePath, chain.id, id)
    ].join('\n\n'),
    reviewRepair: {
      groupId: review.groupId,
      afterRound: review.round,
      candidateVersion: review.candidateVersion,
      consumptionKey: `${review.groupId}:repair:${review.round}:${review.candidateVersion}`,
      withSource: true
    }
  }
}

function sourceReviewRounds(
  chain: SessionChain,
  firstReviewer: SessionChainAgentStep
): Map<number, SessionChainAgentStep[]> {
  const { groupId, maxRounds } = firstReviewer.review!
  if (!Number.isInteger(maxRounds) || maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS) {
    throw new Error('Repeated reviews must stay within the five-round limit.')
  }
  const rounds = new Map<number, SessionChainAgentStep[]>()
  for (const step of chain.steps) {
    if (
      step.kind === 'handoff' ||
      (step.planVersion ?? 1) !== (chain.planVersion ?? 1) ||
      step.review?.groupId !== groupId
    ) {
      continue
    }
    const review = step.review
    if (
      !review.repairWithSource ||
      review.maxRounds !== maxRounds ||
      !Number.isInteger(review.round) ||
      review.round < 1 ||
      review.round > maxRounds
    ) {
      throw new Error(
        'Every source review must keep the same selected round count and repair owner.'
      )
    }
    const members = rounds.get(review.round) ?? []
    members.push(step)
    rounds.set(review.round, members)
  }
  const expected = new Set(rounds.get(1)?.map((step) => step.review!.reviewerId))
  for (let round = 1; round <= maxRounds; round += 1) {
    const members = rounds.get(round)
    if (!members?.length) {
      throw new Error(
        'A repeated review round is missing its reviewers. Save the review plan again.'
      )
    }
    const identities = new Set(members.map((step) => step.review!.reviewerId))
    if (
      identities.size !== members.length ||
      identities.size !== expected.size ||
      [...identities].some((id) => !expected.has(id))
    ) {
      throw new Error('Every review round must retain the same unique selected reviewers.')
    }
  }
  return rounds
}

/** Bind repeated reviews to the authenticated producer without replacing prior repair receipts. */
export function materializeSessionOutcomeSourceRepairs(
  chain: SessionChain,
  sourceActor?: NextStepActor
): SessionChain {
  const groups = new Map<string, SessionChainAgentStep>()
  for (const step of chain.steps) {
    if (
      step.kind !== 'handoff' &&
      (step.planVersion ?? 1) === (chain.planVersion ?? 1) &&
      step.review?.repairWithSource &&
      step.review.maxRounds > 1
    ) {
      if (!groups.has(step.review.groupId)) {
        groups.set(step.review.groupId, step)
      }
    }
  }
  const insertions = new Map<string, SessionChainAgentStep>()
  for (const [groupId, firstReviewer] of groups) {
    const repairs = chain.steps.filter(
      (step): step is SessionChainAgentStep =>
        step.kind !== 'handoff' &&
        (step.planVersion ?? 1) === (chain.planVersion ?? 1) &&
        step.reviewRepair?.groupId === groupId
    )
    if (repairs.some((step) => !step.reviewRepair!.withSource)) {
      continue
    }
    const rounds = sourceReviewRounds(chain, firstReviewer)
    const maxRounds = firstReviewer.review!.maxRounds
    let actor: NextStepActor | undefined
    for (let round = 1; round < maxRounds; round += 1) {
      const existing = repairs.filter((step) => step.reviewRepair!.afterRound === round)
      if (existing.length > 1) {
        throw new Error('This review round already has more than one source repair step.')
      }
      if (existing.length === 1) {
        continue
      }
      const reviewer = rounds.get(round)!.at(-1)!
      actor ??= sourceRepairActor(chain, firstReviewer, sourceActor)
      const repair = sourceRepairStep(chain, reviewer, actor)
      if (chain.steps.some((step) => step.id === repair.id)) {
        throw new Error('The source repair identity is already used by another step.')
      }
      insertions.set(reviewer.id, repair)
    }
  }
  if (insertions.size === 0) {
    return chain
  }
  const steps = chain.steps.flatMap((step): SessionChainStep[] => {
    const repair = insertions.get(step.id)
    return repair ? [step, repair] : [step]
  })
  return {
    ...chain,
    steps,
    ...(chain.outcomeSet
      ? {
          outcomeSet: {
            ...chain.outcomeSet,
            outcomes: chain.outcomeSet.outcomes.map((outcome) => {
              if (![...insertions.values()].some((step) => step.outcomeId === outcome.id)) {
                return outcome
              }
              const stepIds =
                outcome.stepIds ??
                chain.steps.filter((step) => step.outcomeId === outcome.id).map((step) => step.id)
              return {
                ...outcome,
                stepIds: stepIds.flatMap((id) => {
                  const repair = insertions.get(id)
                  return repair?.outcomeId === outcome.id ? [id, repair.id] : [id]
                })
              }
            })
          }
        }
      : {})
  }
}
