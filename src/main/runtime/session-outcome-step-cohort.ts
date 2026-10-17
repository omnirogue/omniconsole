import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStepEnabledBy
} from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAction,
  SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import { isVerifyGateStep } from '../../shared/session-chain-verdict-checks'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'
import { sameReviewRound } from './session-outcome-review-round'
import { blockOutcome, setStepWait, type OutcomeStepAccess } from './session-outcome-step-progress'
import { prepareOutcomeStep } from './session-outcome-step-brief'
import { sessionOutcomeExecutionBrief } from './session-outcome-executor'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { refusedSessionOutcomeAttempt } from './session-outcome-attempt-failure'

/**
 * The seats that start together with this one: its review round, its parallel group, or only
 * itself. Review is asked FIRST because a compiled reviewer carries both `review` and `group`
 * (`next-outcome-compile.ts` names the round as the group), and the round owns candidate pinning.
 */
export function sessionOutcomeStepCohort(
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep
): SessionChainAgentStep[] {
  const members = (outcome.stepIds ?? []).flatMap((id) => {
    const candidate = chain.steps.find((entry) => entry.id === id)
    return candidate && candidate.kind !== 'handoff' ? [candidate] : []
  })
  if (step.review) {
    return members.filter((member) => sameReviewRound(member, step))
  }
  return step.group ? members.filter((member) => member.group === step.group) : [step]
}

/** A verdict a seat waits on has landed only when the host spent a receipt for it. */
function verdictLanded(chain: SessionChain, enabledBy: SessionChainStepEnabledBy): boolean {
  return (chain.verdicts ?? []).some((receipt) => {
    const seat = chain.steps.find((step) => step.id === receipt.stepId)
    return (
      !receipt.skipped &&
      (receipt.stepId === enabledBy.verdict ||
        (seat?.kind !== 'handoff' && seat?.planNodeId === enabledBy.verdict))
    )
  })
}

/** A seat is not startable while it is finished, already launched, or held for a verdict. */
function cohortEligibility(
  chain: SessionChain,
  cohort: SessionChainAgentStep[]
): { ready: SessionChainAgentStep[]; held: SessionChainAgentStep[] } {
  const set = chain.outcomeSet!
  const unfinished = cohort.filter(
    (step) =>
      !set.completedSteps?.includes(step.id) &&
      !set.attempts.some(
        (attempt) =>
          attempt.actionId === sessionOutcomeStepActionId(step.id) &&
          attempt.state !== 'retryable' &&
          attempt.state !== 'superseded'
      )
  )
  return {
    ready: unfinished.filter((step) => !step.enabledBy || verdictLanded(chain, step.enabledBy)),
    held: unfinished.filter((step) => step.enabledBy && !verdictLanded(chain, step.enabledBy))
  }
}

/**
 * Has any work of the CURRENT plan version started? If not, this cohort is the chain's first
 * step, and the source conversation's own turn must be finished before it may read it.
 */
function chainHasStarted(chain: SessionChain): boolean {
  const version = chain.planVersion ?? 1
  const completed = chain.outcomeSet?.completedSteps ?? []
  return chain.steps.some(
    (step) =>
      step.kind !== 'handoff' &&
      (step.planVersion ?? 1) === version &&
      (step.status === 'launched' || completed.includes(step.id))
  )
}

/**
 * Start what this step's cohort may run now: the first `budget` startable seats launch together,
 * every other seat is recorded as waiting and why. Generalises the review round, which was the
 * only fan-out the host had — an authored parallel group launched one member at a time.
 *
 * A chain's FIRST step also waits for the source conversation to be idle at THIS moment, not
 * merely to have been idle once: `continuation.sourceReady` is sticky, so a person who kept
 * typing — or a new plan version composed mid-turn — would otherwise have their unfinished
 * turn read as the starting state. The seats are held with `wait.reason: 'dependency'`, and
 * the next tick asks again.
 *
 * Only a DEFINITE reading holds them. A source that cannot be read at all is the
 * continuation's own business (`state: 'unverifiable'`, set by the tick, which still admits
 * work it already owns); treating an unreadable pane as "mid-turn" here would stop a chain
 * whose pane merely went away.
 */
export async function launchStepCohort(
  access: OutcomeStepAccess,
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  budget: number,
  /** The pass's clock: waits, refusals and blocks written here are measured from it. */
  since = Date.now()
): Promise<{ launched: string[]; waiting: string[] }> {
  const { ready, held } = cohortEligibility(chain, sessionOutcomeStepCohort(chain, outcome, step))
  if (ready.length && !chainHasStarted(chain)) {
    const source = await observeSessionOutcomeSource(access.runtime, chain)
    if (!source.ready && !source.unverifiable) {
      for (const entry of [...ready, ...held]) {
        setStepWait(access, chain.id, entry.id, {
          reason: 'dependency',
          since,
          ref: chain.sourcePaneKey
        })
      }
      return { launched: [], waiting: [...ready, ...held].map((entry) => entry.id) }
    }
  }
  const admitted = ready.slice(0, Math.max(0, budget))
  const waiting = [
    ...ready.slice(admitted.length).map((entry) => {
      setStepWait(access, chain.id, entry.id, { reason: 'capacity', since })
      return entry.id
    }),
    ...held.map((entry) => {
      setStepWait(access, chain.id, entry.id, {
        reason: 'dependency',
        since,
        ref: entry.enabledBy!.verdict
      })
      return entry.id
    })
  ]
  // A verdict seat has to be told the immutable version it judges, because its envelope names that
  // version back and the consumer compares it against the workspace it reads at completion. A
  // review seat already carries its round's pin (`step.review.candidateVersion`); every other
  // verdict seat — judge, critique, verify — is pinned here, once for the whole cohort.
  const seats = admitted.filter((member) => member.verdict && !member.review?.candidateVersion)
  const pin = seats.length
    ? await sessionOutcomeCandidateVersion(
        chain.workspacePath,
        sessionOutcomeCandidatePaths(outcome, chain),
        { folderPin: seats.every(isVerifyGateStep) }
      )
    : undefined
  // Staged one by one (each reads the chain back), then started together: a slow first launch must
  // not hold back the rest of the cohort.
  const staged: { id: string; launch: () => Promise<unknown> }[] = []
  const refusals: SessionOutcomeAttempt[] = []
  for (const member of admitted) {
    let action: SessionOutcomeAction | undefined
    try {
      const prepared = prepareOutcomeStep(access, outcome, member.id, pin)
      action = prepared.action
      // An oversized brief is refused, never silently trimmed to fit: #283 removed the tail-slice
      // that used to drop the front of the predecessor reports.
      sessionOutcomeExecutionBrief(access.read(), prepared.action, 'pending')
      staged.push({ id: member.id, launch: prepared.launch })
    } catch (error) {
      refusals.push(
        refusedSessionOutcomeAttempt({
          outcome,
          planVersion: chain.planVersion,
          actionId: sessionOutcomeStepActionId(member.id),
          action,
          error,
          now: since
        })
      )
    }
  }
  if (refusals.length) {
    // The refusal is recorded on the attempt, so the plan shows WHICH seat could not be briefed —
    // and nothing in a blocked outcome starts while its brief is still too large.
    for (const refusal of refusals) {
      access.persistAttempt(refusal)
    }
    // Held as recovering until the host's next pass reads the refused attempts: the ladder turns
    // an oversized brief into a request and anything else into a bounded retry.
    blockOutcome(
      access,
      outcome.id,
      refusals[0]!.error!,
      { class: 'recovering', code: refusals[0]!.failure?.code ?? 'launch-not-started' },
      since
    )
    return { launched: [], waiting: [...waiting, ...staged.map((entry) => entry.id)] }
  }
  await Promise.all(staged.map((entry) => entry.launch()))
  return { launched: staged.map((entry) => entry.id), waiting }
}
