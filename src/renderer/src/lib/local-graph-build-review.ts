import {
  BUILD_REVIEW_MAX_ROUNDS,
  type BuildReviewPipelineSnapshot,
  type BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import type { LocalRunNodeState } from '../../../shared/local-run-node-state'
import {
  pipelineProblemText,
  workerProblemText
} from '@/components/build-review/build-review-plain-text'
import type { LocalGraphLoop, LocalGraphNode, LocalGraphView } from './local-graph-view'

/**
 * A Build + Review pipeline as the same graph the canvas draws for a local Run: a
 * builder, its reviewers, and the repeat edge back to the builder carrying the round
 * counter the pipeline already stores. The loop is real here — the pipeline re-runs
 * the builder after REQUEST_CHANGES until everyone approves or the cap is reached.
 */
export function buildReviewGraphView(
  pipeline: BuildReviewPipelineSnapshot,
  options: { workspacePath?: string | null } = {}
): LocalGraphView {
  const round = pipeline.round ?? pipeline.rounds?.length ?? 1
  const maxRounds = pipeline.maxReviewRounds ?? BUILD_REVIEW_MAX_ROUNDS
  const current =
    pipeline.rounds?.find((entry) => entry.number === round) ?? pipeline.rounds?.at(-1)
  const builder = current?.builder ?? pipeline.builder
  const reviewers = current?.reviewers ?? pipeline.reviewers ?? [pipeline.reviewer]
  const workspacePath =
    options.workspacePath?.trim() ||
    workspacePathFromSelector(pipeline.worktree) ||
    workspacePathFromSelector(pipeline.worktreeId ?? '') ||
    pipeline.worktree
  const questions =
    pipeline.pendingQuestions ?? (pipeline.pendingQuestion ? [pipeline.pendingQuestion] : [])
  const builderQuestion = questions.find((question) => question.role === 'builder') ?? null
  // A question names the dispatch that asked it; one stored before that (role only) goes to
  // the first running reviewer, the only place it could have come from when reviews ran in order.
  const runningReviewer = Math.max(
    reviewers.findIndex((worker) => worker.status === 'running'),
    0
  )
  const reviewerQuestion = (worker: (typeof reviewers)[number], index: number) =>
    questions.find(
      (question) =>
        question.role === 'reviewer' &&
        (question.dispatchId
          ? question.dispatchId === worker.dispatchId
          : index === runningReviewer)
    ) ?? null
  const nodes: LocalGraphNode[] = [
    workerNode({
      id: 'builder',
      worker: builder,
      objective: pipeline.objective,
      after: [],
      workspacePath,
      round,
      needsInput: Boolean(builderQuestion),
      question: builderQuestion
    }),
    ...reviewers.map((worker, index) =>
      workerNode({
        id: reviewerNodeId(reviewers.length, index),
        worker,
        objective: pipeline.reviewFocus ?? pipeline.objective,
        after: ['builder'],
        workspacePath,
        round,
        needsInput: Boolean(reviewerQuestion(worker, index)),
        question: reviewerQuestion(worker, index)
      })
    )
  ]
  const loops: LocalGraphLoop[] = reviewers.map((_worker, index) => ({
    from: reviewerNodeId(reviewers.length, index),
    to: 'builder',
    round,
    maxRounds
  }))
  return {
    id: pipeline.id,
    source: 'build-review',
    stage: pipeline.stage,
    workspacePath,
    workspaceKind: null,
    coordinatorTerminalHandle: pipeline.coordinatorTerminalHandle,
    nodes,
    loops,
    events: pipeline.events.map((event) => ({
      at: event.at,
      kind: event.kind,
      node:
        event.role === 'pipeline'
          ? 'run'
          : event.role === 'builder'
            ? 'builder'
            : reviewerNodeId(reviewers.length, 0),
      text: event.text
    })),
    // Why in words: the runtime's line carries ids and codes; the timeline keeps it as it was.
    error: pipelineProblemText(pipeline),
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt
  }
}

function reviewerNodeId(count: number, index: number): string {
  return count > 1 ? `reviewer-${index + 1}` : 'reviewer'
}

/** `<repoId>::<path>`, optionally behind an `id:` selector prefix. */
export function workspacePathFromSelector(selector: string): string | null {
  const marker = selector.indexOf('::')
  return marker === -1 ? null : selector.slice(marker + 2).trim() || null
}

function workerNode(args: {
  id: string
  worker: BuildReviewWorkerSnapshot
  objective: string
  after: string[]
  workspacePath: string
  round: number
  needsInput: boolean
  question: BuildReviewPipelineSnapshot['pendingQuestion']
}): LocalGraphNode {
  return {
    id: args.id,
    state: buildReviewNodeState(args.worker, args.needsInput),
    actor: args.worker.choice,
    ...(args.worker.effortParity ? { effortParity: args.worker.effortParity } : {}),
    presetId: args.worker.role === 'reviewer' ? 'review' : 'implement',
    objective: args.objective,
    after: args.after,
    placement: 'local',
    workspacePath: args.workspacePath,
    childWorkspaceName: null,
    producedFiles: args.worker.report?.filesModified ?? [],
    manifestPath: null,
    reportPath: args.worker.report?.reportPath ?? null,
    outputDir: null,
    terminalHandle: args.worker.terminalHandle,
    gateQuestion: null,
    question:
      args.needsInput && args.question
        ? {
            // Why: Build + Review workers ask through the orchestration mailbox.
            source: 'mailbox' as const,
            messageId: args.question.messageId,
            question: args.question.question,
            options: args.question.options,
            askedAt: args.question.askedAt
          }
        : null,
    deliveryId: null,
    error: workerProblemText(args.worker),
    round: args.round
  }
}

/**
 * The same precedence the local runner uses: an unanswered question beats RUNNING,
 * because that is the state a person has to act on.
 */
export function buildReviewNodeState(
  worker: BuildReviewWorkerSnapshot,
  needsInput: boolean
): LocalRunNodeState {
  if (needsInput) {
    return 'needs-input'
  }
  switch (worker.status) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'running':
      return worker.role === 'reviewer' ? 'reviewing' : 'running'
    case 'starting':
      return 'running'
    case 'pending':
      break
  }
  return 'queued'
}
