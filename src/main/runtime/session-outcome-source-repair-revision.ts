import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { sessionOutcomeStepSignature } from './session-outcome-revision'

function reviewGroups(chain: SessionChain): Map<string, SessionChainAgentStep[]> {
  const groups = new Map<string, SessionChainAgentStep[]>()
  for (const step of chain.steps) {
    if (step.kind === 'handoff' || !step.review) {
      continue
    }
    const members = groups.get(step.review.groupId) ?? []
    members.push(step)
    groups.set(step.review.groupId, members)
  }
  return groups
}

function unchangedReviewers(
  current: SessionChainAgentStep[],
  previous: SessionChainAgentStep[]
): boolean {
  const signatures = new Map(previous.map((step) => [step.id, sessionOutcomeStepSignature(step)]))
  return (
    current.length === previous.length &&
    signatures.size === previous.length &&
    new Set(current.map((step) => step.id)).size === current.length &&
    current.every(
      (step) =>
        step.review?.repairWithSource &&
        signatures.get(step.id) === sessionOutcomeStepSignature(step)
    )
  )
}

/** The editor omits host-owned repairs; unchanged reviews retain their exact pinned work. */
export function restoreSessionOutcomeSourceRepairs(
  chain: SessionChain,
  previous: SessionChain | undefined,
  input: SessionOutcomeCommit
): { chain: SessionChain; input: SessionOutcomeCommit } {
  if (!previous || previous.id !== chain.id) {
    return { chain, input }
  }
  const currentGroups = reviewGroups(chain)
  const previousGroups = reviewGroups(previous)
  const insertions = new Map<string, SessionChainAgentStep[]>()
  const existingIds = new Set(chain.steps.map((step) => step.id))
  for (const repair of previous.steps) {
    if (repair.kind === 'handoff' || !repair.reviewRepair?.withSource) {
      continue
    }
    const { groupId, afterRound } = repair.reviewRepair
    const current = currentGroups.get(groupId)
    const prior = previousGroups.get(groupId)
    if (!current || !prior || !unchangedReviewers(current, prior)) {
      continue
    }
    if (
      existingIds.has(repair.id) ||
      chain.steps.some(
        (step) =>
          step.kind !== 'handoff' &&
          step.reviewRepair?.groupId === groupId &&
          step.reviewRepair.afterRound === afterRound
      )
    ) {
      continue
    }
    const lastReviewer = current.findLast((step) => step.review!.round === afterRound)
    const owner = input.outcomes.find((outcome) => outcome.id === repair.outcomeId)
    if (!lastReviewer || !owner) {
      continue
    }
    const ownerStepIds =
      owner.stepIds ??
      chain.steps.filter((step) => step.outcomeId === owner.id).map((step) => step.id)
    if (!ownerStepIds.includes(lastReviewer.id)) {
      continue
    }
    const repairs = insertions.get(lastReviewer.id) ?? []
    repairs.push(repair)
    insertions.set(lastReviewer.id, repairs)
    existingIds.add(repair.id)
  }
  if (!insertions.size) {
    return { chain, input }
  }
  return {
    chain: {
      ...chain,
      steps: chain.steps.flatMap((step): SessionChainStep[] => [
        step,
        ...(insertions.get(step.id) ?? [])
      ])
    },
    input: {
      ...input,
      outcomes: input.outcomes.map((outcome) => {
        if (![...insertions.values()].flat().some((step) => step.outcomeId === outcome.id)) {
          return outcome
        }
        const stepIds =
          outcome.stepIds ??
          chain.steps.filter((step) => step.outcomeId === outcome.id).map((step) => step.id)
        return {
          ...outcome,
          stepIds: stepIds.flatMap((id) => [
            id,
            ...(insertions.get(id) ?? [])
              .filter((repair) => repair.outcomeId === outcome.id && !stepIds.includes(repair.id))
              .map((repair) => repair.id)
          ])
        }
      })
    }
  }
}
