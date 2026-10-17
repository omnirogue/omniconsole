import { NEXT_STEP_MAX_REVIEW_ROUNDS, NEXT_STEP_MAX_REVIEWERS } from './next-step-draft'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep,
  type SessionChainStep
} from './session-chain-types'

/**
 * The ONE review-round contract, with ONE message set, over a COMPILED chain. Ten-plus sites
 * across three packages each carried a private copy of some of these rules -- one concept,
 * "this repeated review has no repairer", had four different sentences -- so a round one surface
 * accepted was refused by the next one in words the person had not seen. Every chain-level site
 * becomes a caller; the draft-level validators stay where they are, because they run before a
 * chain exists. `when: 'launching'` adds the host's readiness rule: the source repairs that
 * materializeSessionOutcomeSourceRepairs binds must already be there.
 */
export type SessionChainReviewContractCode =
  | 'review-assignment-invalid'
  | 'review-rounds-over-cap'
  | 'review-too-many-reviewers'
  | 'review-round-missing-reviewers'
  | 'review-round-reviewers-differ'
  | 'review-group-inconsistent'
  | 'review-round-candidate-version'
  | 'review-rounds-need-repair'
  | 'review-repair-duplicate'
  | 'review-repair-out-of-order'
  | 'review-repair-consumption-key'
  | 'review-repair-unknown-group'

export type SessionChainReviewContractProblem = {
  code: SessionChainReviewContractCode
  stepId: string
  message: string
}

const MESSAGES: Record<SessionChainReviewContractCode, string> = {
  'review-assignment-invalid':
    'A review step is missing a usable round assignment. Save the review plan again.',
  'review-rounds-over-cap': 'Repeated reviews must stay within the five-round limit.',
  'review-too-many-reviewers': 'Choose up to five reviewers.',
  'review-round-missing-reviewers':
    'A repeated review round is missing its reviewers. Save the review plan again.',
  'review-round-reviewers-differ':
    'Every review round must retain the same unique selected reviewers.',
  'review-group-inconsistent':
    'Every source review must keep the same selected round count and repair owner.',
  'review-round-candidate-version':
    'Every reviewer in one round must judge the same candidate version.',
  // Verbatim from session-outcome-steps.ts:157, the host's own words for the one concept the
  // draft validator, the canonical compiler and the materialization each phrased differently.
  'review-rounds-need-repair':
    'Repeated review rounds require their authorized repair owner before execution.',
  'review-repair-duplicate': 'This review round already has more than one source repair step.',
  'review-repair-out-of-order':
    'Place a repair agent immediately after its review, or turn off repair mode.',
  'review-repair-consumption-key':
    'A review repair carries a consumption key that does not match its round. Save the review plan again.',
  'review-repair-unknown-group': 'A repair step names a review that is not in this plan.'
}

function problem(
  code: SessionChainReviewContractCode,
  stepId: string
): SessionChainReviewContractProblem {
  return { code, stepId, message: MESSAGES[code] }
}

function agentSteps(chain: Pick<SessionChain, 'steps'>): SessionChainAgentStep[] {
  return chain.steps.filter(isSessionChainAgentStep)
}

function groupIdOf(step: SessionChainStep): string | null {
  if (!isSessionChainAgentStep(step)) {
    return null
  }
  return step.review?.groupId ?? step.reviewRepair?.groupId ?? null
}

function assignmentProblems(
  reviewers: SessionChainAgentStep[]
): SessionChainReviewContractProblem[] {
  const problems: SessionChainReviewContractProblem[] = []
  for (const reviewer of reviewers) {
    const { round, maxRounds, reviewerId, candidateVersion } = reviewer.review!
    if (
      !Number.isInteger(round) ||
      !Number.isInteger(maxRounds) ||
      round < 1 ||
      round > maxRounds ||
      !reviewerId.trim() ||
      !candidateVersion.trim()
    ) {
      problems.push(problem('review-assignment-invalid', reviewer.id))
    }
  }
  return problems
}

function roundProblems(
  reviewers: SessionChainAgentStep[],
  maxRounds: number
): SessionChainReviewContractProblem[] {
  const problems: SessionChainReviewContractProblem[] = []
  const first = reviewers[0]!
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS) {
    problems.push(problem('review-rounds-over-cap', first.id))
    return problems
  }
  const withSource = Boolean(first.review!.repairWithSource)
  if (
    reviewers.some(
      (entry) =>
        entry.review!.maxRounds !== maxRounds ||
        Boolean(entry.review!.repairWithSource) !== withSource
    )
  ) {
    problems.push(problem('review-group-inconsistent', first.id))
  }
  const expected = new Set(
    reviewers.filter((entry) => entry.review!.round === 1).map((entry) => entry.review!.reviewerId)
  )
  for (let round = 1; round <= maxRounds; round += 1) {
    const members = reviewers.filter((entry) => entry.review!.round === round)
    if (members.length === 0) {
      problems.push(problem('review-round-missing-reviewers', first.id))
      continue
    }
    if (members.length > NEXT_STEP_MAX_REVIEWERS) {
      problems.push(problem('review-too-many-reviewers', members[0]!.id))
    }
    const identities = new Set(members.map((entry) => entry.review!.reviewerId))
    if (
      identities.size !== members.length ||
      identities.size !== expected.size ||
      [...identities].some((id) => !expected.has(id))
    ) {
      problems.push(problem('review-round-reviewers-differ', members[0]!.id))
    }
    if (new Set(members.map((entry) => entry.review!.candidateVersion)).size > 1) {
      problems.push(problem('review-round-candidate-version', members[0]!.id))
    }
  }
  return problems
}

function repairProblems(
  steps: SessionChainAgentStep[],
  reviewers: SessionChainAgentStep[],
  repairs: SessionChainAgentStep[],
  maxRounds: number,
  when: 'authored' | 'launching'
): SessionChainReviewContractProblem[] {
  const problems: SessionChainReviewContractProblem[] = []
  const first = reviewers[0]!
  const withSource = Boolean(first.review!.repairWithSource)
  const position = (step: SessionChainAgentStep): number =>
    steps.findIndex((entry) => entry.id === step.id)
  for (const repair of repairs) {
    const { afterRound, candidateVersion, consumptionKey, groupId } = repair.reviewRepair!
    if (consumptionKey !== `${groupId}:repair:${afterRound}:${candidateVersion}`) {
      problems.push(problem('review-repair-consumption-key', repair.id))
    }
    if (repairs.filter((entry) => entry.reviewRepair!.afterRound === afterRound).length > 1) {
      problems.push(problem('review-repair-duplicate', repair.id))
    }
    const own = reviewers.filter((entry) => entry.review!.round === afterRound)
    const later = reviewers.filter((entry) => entry.review!.round > afterRound)
    if (
      own.length === 0 ||
      own.some((entry) => position(entry) > position(repair)) ||
      later.some((entry) => position(entry) < position(repair))
    ) {
      problems.push(problem('review-repair-out-of-order', repair.id))
    }
  }
  if (maxRounds <= 1) {
    return problems
  }
  const rounds = new Set(repairs.map((entry) => entry.reviewRepair!.afterRound))
  const missing = Array.from({ length: maxRounds - 1 }, (_, index) => index + 1).filter(
    (round) => !rounds.has(round)
  )
  if (missing.length === 0) {
    return problems
  }
  // Source repairs are inserted by the host before execution, so their absence is only a fault
  // once a round is about to launch; a plan with no repair owner at all is never executable.
  if (withSource && when === 'authored') {
    return problems
  }
  problems.push(problem('review-rounds-need-repair', first.id))
  return problems
}

/** Every problem is a refusal: a round that breaks one of these cannot be executed honestly. */
export function reviewRoundContractProblems(
  chain: Pick<SessionChain, 'steps'>,
  step: SessionChainStep,
  when: 'authored' | 'launching' = 'authored'
): SessionChainReviewContractProblem[] {
  const groupId = groupIdOf(step)
  if (!groupId) {
    return []
  }
  const steps = agentSteps(chain)
  const reviewers = steps.filter((entry) => entry.review?.groupId === groupId)
  const repairs = steps.filter((entry) => entry.reviewRepair?.groupId === groupId)
  if (reviewers.length === 0) {
    return [problem('review-repair-unknown-group', step.id)]
  }
  const invalid = assignmentProblems(reviewers)
  if (invalid.length > 0) {
    return invalid
  }
  const maxRounds = reviewers[0]!.review!.maxRounds
  const rounds = roundProblems(reviewers, maxRounds)
  // An impossible round count is fixed before anything else about the round means much; the
  // materialization refuses in the same order (session-outcome-source-repairs.ts:91).
  return rounds.some((entry) => entry.code === 'review-rounds-over-cap')
    ? rounds
    : [...rounds, ...repairProblems(steps, reviewers, repairs, maxRounds, when)]
}
