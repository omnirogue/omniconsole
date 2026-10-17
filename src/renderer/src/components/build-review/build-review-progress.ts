import {
  buildReviewEndedWithChangesRequested,
  reviewVerdict,
  type BuildReviewPipelineSnapshot,
  type BuildReviewWorkerSnapshot
} from '../../../../shared/build-review-pipeline'
import { reviewFindingBlocks } from '../../../../shared/review-findings'

export type BuildReviewStepId = 'build' | 'review' | 'fix'
export type BuildReviewStepState =
  | 'upcoming'
  | 'active'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'round-limit'
export type BuildReviewStep = { id: BuildReviewStepId; state: BuildReviewStepState }
export type BuildReviewOutcome = 'approved' | 'changes-requested'
export type BuildReviewWorkerVerdict = 'approved' | 'changes-requested' | 'missing'

export function currentReviewers(
  pipeline: BuildReviewPipelineSnapshot
): BuildReviewWorkerSnapshot[] {
  return pipeline.reviewers ?? [pipeline.reviewer]
}

/**
 * Where the run is, or where it stopped. The pipeline only knows `building` and `reviewing`;
 * a build in round 2 or later is the fix step, because the builder is repairing findings.
 */
function currentStep(pipeline: BuildReviewPipelineSnapshot): BuildReviewStepId | null {
  const fixing = (pipeline.round ?? 1) > 1
  switch (pipeline.stage) {
    case 'starting':
      return 'build'
    case 'building':
      return fixing ? 'fix' : 'build'
    case 'reviewing':
      return 'review'
    case 'completed':
      return null
    case 'failed':
    case 'cancelled':
      // A reviewer that left `pending` means the build finished and the review was under way.
      return currentReviewers(pipeline).some((worker) => worker.status !== 'pending')
        ? 'review'
        : fixing
          ? 'fix'
          : 'build'
  }
}

/** The Build → Review → Fix stepper, each step with its state for the current round. */
export function buildReviewSteps(pipeline: BuildReviewPipelineSnapshot): BuildReviewStep[] {
  // Why: the last round's review finished and asked for a fix no round is left for, so the run
  // stopped after Review rather than failing in it. The fix was needed, so never "Not needed".
  if (buildReviewEndedWithChangesRequested(pipeline)) {
    return [
      { id: 'build', state: 'done' },
      { id: 'review', state: 'done' },
      { id: 'fix', state: 'round-limit' }
    ]
  }
  const fixing = (pipeline.round ?? 1) > 1
  const current = currentStep(pipeline)
  const here: BuildReviewStepState =
    pipeline.stage === 'failed' ? 'failed' : pipeline.stage === 'cancelled' ? 'cancelled' : 'active'
  const stateOf = (id: BuildReviewStepId): BuildReviewStepState => {
    if (current === id) {
      return here
    }
    switch (id) {
      case 'build':
        return 'done'
      case 'review':
        return current === 'build' ? 'upcoming' : 'done'
      case 'fix':
        if (current === null) {
          return fixing ? 'done' : 'skipped'
        }
        // Why upcoming even after a fix: the steps read left to right, and a round's review
        // comes before any fix it asks for. The round label says a fix already happened.
        return 'upcoming'
    }
  }
  return (['build', 'review', 'fix'] as const).map((id) => ({ id, state: stateOf(id) }))
}

export function workerVerdict(worker: BuildReviewWorkerSnapshot): BuildReviewWorkerVerdict | null {
  if (worker.role !== 'reviewer' || worker.report?.outcome !== 'succeeded') {
    return null
  }
  switch (reviewVerdict(worker.report.body)) {
    case 'APPROVE':
      return 'approved'
    case 'REQUEST_CHANGES':
      return 'changes-requested'
    case null:
      return 'missing'
  }
}

/**
 * Whether the host withholds this reviewer's approval: its checked findings decide when it has
 * them, its verdict line otherwise. Null while that is not known yet.
 */
function reviewerBlocks(
  worker: BuildReviewWorkerSnapshot,
  evidenceRequired: boolean
): boolean | null {
  const verdict = workerVerdict(worker)
  if (verdict === null || verdict === 'missing') {
    return null
  }
  if (Array.isArray(worker.findings)) {
    return worker.findings.some(reviewFindingBlocks)
  }
  // Evidence runs judge findings once every reviewer settled; until then the verdict is not the outcome.
  if (evidenceRequired && worker.findings === undefined) {
    return null
  }
  return verdict === 'changes-requested'
}

/** One round's outcome as the host judged it, once every reviewer has reported. */
export function reviewersOutcome(
  reviewers: readonly BuildReviewWorkerSnapshot[],
  evidenceRequired = false
): BuildReviewOutcome | null {
  if (reviewers.length === 0 || reviewers.some((worker) => worker.status !== 'succeeded')) {
    return null
  }
  const blocks = reviewers.map((worker) => reviewerBlocks(worker, evidenceRequired))
  if (blocks.some((entry) => entry === true)) {
    return 'changes-requested'
  }
  return blocks.every((entry) => entry === false) ? 'approved' : null
}

/** The run's verdict: approved when it completed, otherwise its current round's judged outcome. */
export function buildReviewOutcome(
  pipeline: BuildReviewPipelineSnapshot
): BuildReviewOutcome | null {
  if (pipeline.stage === 'completed') {
    return 'approved'
  }
  return reviewersOutcome(currentReviewers(pipeline), pipeline.evidenceRequired === true)
}
