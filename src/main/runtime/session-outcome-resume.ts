import { verifyGitHubReviewAdmission } from '../console-workflows/console-github-review-readback'
import { sessionOutcomeHandoffBlocker } from './session-outcome-handoff'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import {
  recoverSessionOutcomeAttempts,
  sessionOutcomePassClock
} from './session-outcome-attempt-recovery'
import { rekeyRefusedSessionOutcomeHandoff } from './session-outcome-handoff-recovery'
import { resumeSessionReviewVerdicts } from './session-outcome-verdict-reask'
import { observeSessionOutcomeAttempt } from './session-outcome-executor'

/**
 * The person's Resume: the same recovery ladder the host runs by itself, with the retry bound and
 * the deadline lifted — never the safety proof, so only proven-unstarted or proven-dead work runs
 * again and anything uncertain is still reconciled by receipts. Runs inside the chain's lane, so
 * it and a concurrent tick can never both replace one attempt.
 */
export async function resumeSessionOutcomeWork(
  service: SessionOutcomeService,
  chain: SessionChain,
  at?: number
): Promise<SessionChain> {
  let set = chain.outcomeSet!
  // A sealed run stays complete: new work forks a new run, and Resume has nothing to resume.
  if (set.completion) {
    return chain
  }
  const now = sessionOutcomePassClock(service, at)
  const resumeActivation = (workflow: SessionOutcomeWorkflow): SessionOutcomeWorkflow => {
    if (
      workflow.retired ||
      !workflow.activations.some((entry) => entry.state === 'unverifiable' && !entry.dispatchId)
    ) {
      return workflow
    }
    return {
      ...workflow,
      error: undefined,
      activations: workflow.activations.map((entry) =>
        entry.state === 'unverifiable' && !entry.dispatchId
          ? { ...entry, state: 'requested', error: undefined, launchDisposition: undefined }
          : entry
      )
    }
  }
  set = {
    ...set,
    ...(set.workflow ? { workflow: resumeActivation(set.workflow) } : {}),
    ...(set.workflowHistory ? { workflowHistory: set.workflowHistory.map(resumeActivation) } : {})
  }
  // Resume may arrive before the next host tick. Reconcile the durable Run-only checkpoint first,
  // because no Task proves the worker was never requested while an unknown Task remains uncertain.
  set = {
    ...set,
    attempts: set.attempts.map((attempt) =>
      attempt.runId && !attempt.taskId && !attempt.dispatchId && !attempt.conversationTurn
        ? observeSessionOutcomeAttempt(service.runtime, attempt, now)
        : attempt
    )
  }
  for (const operation of set.publications ?? []) {
    if (!['blocked', 'requested'].includes(operation.state)) {
      continue
    }
    const prior = operation.admission
    const observed = await verifyGitHubReviewAdmission({
      repo: prior.review.repo,
      prNumber: prior.review.prNumber,
      headRef: prior.review.headRef,
      expectedBaseRef: prior.review.baseRef,
      producerGitSha: prior.producerGitSha,
      acceptedReviews: prior.acceptedReviews,
      expectedReviewerIds: prior.acceptedReviews.map((review) => review.reviewerId)
    })
    if (observed.review.state === 'open') {
      set = {
        ...set,
        publications: set.publications!.map((entry) =>
          entry.id === operation.id ? { ...entry, state: 'prepared', error: undefined } : entry
        )
      }
    }
  }
  set = await recoverSessionOutcomeAttempts({
    runtime: service.runtime,
    chain,
    set,
    now,
    userInitiated: true,
    inFlight: (attemptId) => Boolean(service.launches?.inFlight(attemptId))
  })
  // A held handoff starts a fresh series: the failure and what it cost are cleared, and only a
  // refused recipient gets a new key (`rekeyRefusedSessionOutcomeHandoff`).
  const releasedOutcomes = new Set<string>()
  const steps = chain.steps.map((step) => {
    if (step.kind !== 'handoff' || !sessionOutcomeHandoffBlocker(step, now)) {
      return step
    }
    set.outcomes
      .filter((outcome) => outcome.stepIds?.includes(step.id))
      .forEach((outcome) => releasedOutcomes.add(outcome.id))
    const { exception: _cleared, ...handoff } = step.handoff
    return { ...step, handoff: rekeyRefusedSessionOutcomeHandoff(handoff) }
  })
  if (releasedOutcomes.size) {
    set = {
      ...set,
      outcomes: set.outcomes.map((outcome) =>
        releasedOutcomes.has(outcome.id) && outcome.status === 'blocked'
          ? { ...outcome, status: 'pending', blockedReason: undefined, block: undefined }
          : outcome
      )
    }
  }
  // A round that stopped because a reviewer returned no verdict is asked again, bound lifted once;
  // one that stopped for findings is a decision already in front of the person, and is left alone.
  const resumed = resumeSessionReviewVerdicts({ ...chain, steps, outcomeSet: set })
  return service.save(resumed, resumed.outcomeSet!.revision)
}
