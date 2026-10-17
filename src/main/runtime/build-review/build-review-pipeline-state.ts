import { HUB_TASK_ID_PATTERN } from '../../../shared/omnios-task-binding'
import { mayIssueVerdict } from '../../../shared/model-lineage'
import { normalizeReviewRubric } from '../../../shared/review-rubrics'
import { randomUUID } from 'node:crypto'
import { localWorkflowLaunchChoice } from '../../../shared/local-workflow-draft'
import type {
  BuildReviewAgentChoice,
  BuildReviewEvent,
  BuildReviewEventKind,
  BuildReviewPipelineSnapshot,
  BuildReviewStage,
  BuildReviewStartRequest,
  BuildReviewWorkerReport,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import {
  BUILD_REVIEW_DEFAULT_BUILDER,
  BUILD_REVIEW_DEFAULT_REVIEWER,
  BUILD_REVIEW_MAX_REVIEWERS,
  BUILD_REVIEW_MAX_ROUNDS
} from '../../../shared/build-review-pipeline'

const MAX_EVENTS = 400

function now(): string {
  return new Date().toISOString()
}

export function createWorker(
  role: 'builder' | 'reviewer',
  choice: BuildReviewAgentChoice
): BuildReviewWorkerSnapshot {
  return {
    role,
    choice: { ...choice },
    status: 'pending',
    taskId: null,
    dispatchId: null,
    terminalHandle: null,
    report: null,
    error: null
  }
}

/** A reviewer keeps a valid rubric (frozen with the run) and never carries an invalid one. */
function withRubric(choice: BuildReviewAgentChoice): BuildReviewAgentChoice {
  const { rubric, ...rest } = choice
  const valid = normalizeReviewRubric(rubric)
  return valid ? { ...rest, rubric: valid } : rest
}

export function createPipelineSnapshot(
  request: BuildReviewStartRequest
): BuildReviewPipelineSnapshot {
  const at = now()
  const hubTaskId = request.hubTaskId?.trim() || null
  if (hubTaskId && !HUB_TASK_ID_PATTERN.test(hubTaskId)) {
    throw new Error('The omnios card id must look like btk_… (letters and digits).')
  }
  const reviewers = (request.reviewers ?? [request.reviewer ?? BUILD_REVIEW_DEFAULT_REVIEWER]).map(
    (choice) => createWorker('reviewer', withRubric(choice))
  )
  return {
    id: `brp_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    runId: null,
    worktree: request.worktree,
    worktreeId: null,
    objective: request.objective,
    reviewFocus: request.reviewFocus?.trim() || null,
    hubTaskId,
    stage: 'starting',
    coordinatorTerminalHandle: null,
    builder: createWorker('builder', request.builder ?? BUILD_REVIEW_DEFAULT_BUILDER),
    reviewer: reviewers[0]!,
    reviewers,
    maxReviewRounds: request.maxReviewRounds ?? 1,
    round: 1,
    rounds: [],
    evidenceRequired: request.evidence !== 'off',
    pendingQuestion: null,
    events: [],
    error: null,
    runsOn: request.runsOn ?? 'fleet',
    ...localWorkflowLaunchChoice(request),
    createdAt: at,
    updatedAt: at
  }
}

export function pushEvent(
  pipeline: BuildReviewPipelineSnapshot,
  kind: BuildReviewEventKind,
  role: BuildReviewEvent['role'],
  text: string
): void {
  pipeline.events.push({ at: now(), kind, role, text })
  if (pipeline.events.length > MAX_EVENTS) {
    pipeline.events.splice(0, pipeline.events.length - MAX_EVENTS)
  }
  pipeline.updatedAt = now()
}

export function setStage(pipeline: BuildReviewPipelineSnapshot, stage: BuildReviewStage): void {
  pipeline.stage = stage
  pipeline.updatedAt = now()
}

export function workerForRole(
  pipeline: BuildReviewPipelineSnapshot,
  role: 'builder' | 'reviewer'
): BuildReviewWorkerSnapshot {
  return role === 'builder' ? pipeline.builder : pipeline.reviewer
}

export function workerForDispatch(
  pipeline: BuildReviewPipelineSnapshot,
  dispatchId: string | undefined
): BuildReviewWorkerSnapshot | null {
  if (!dispatchId) {
    return null
  }
  if (pipeline.builder.dispatchId === dispatchId) {
    return pipeline.builder
  }
  return (
    [pipeline.reviewer, ...(pipeline.reviewers ?? [])].find(
      (worker) => worker.dispatchId === dispatchId
    ) ?? null
  )
}

export function workerForTerminal(
  pipeline: BuildReviewPipelineSnapshot,
  handle: string | undefined
): BuildReviewWorkerSnapshot | null {
  if (!handle) {
    return null
  }
  if (pipeline.builder.terminalHandle === handle) {
    return pipeline.builder
  }
  return (
    [pipeline.reviewer, ...(pipeline.reviewers ?? [])].find(
      (worker) => worker.terminalHandle === handle
    ) ?? null
  )
}

type ParsedPayload = Record<string, unknown>

export function parsePayload(raw: string | null | undefined): ParsedPayload {
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ParsedPayload) : {}
  } catch {
    return {}
  }
}

export function parseFilesModified(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}

export function reportFromMessage(message: {
  subject?: string
  body?: string
  payload?: string | null
}): BuildReviewWorkerReport {
  const payload = parsePayload(message.payload)
  const outcome = payload.outcome === 'succeeded' ? 'succeeded' : 'failed'
  return {
    subject: message.subject ?? '',
    body: message.body ?? '',
    outcome,
    filesModified: parseFilesModified(payload.filesModified ?? payload.files_modified),
    reportPath:
      typeof payload.reportPath === 'string'
        ? payload.reportPath
        : typeof payload.report_path === 'string'
          ? payload.report_path
          : null,
    reportedAt: now()
  }
}

export function parseQuestionOptions(raw: string | null | undefined): string[] {
  const payload = parsePayload(raw)
  return parseFilesModified(payload.options)
}

export function cloneSnapshot(pipeline: BuildReviewPipelineSnapshot): BuildReviewPipelineSnapshot {
  return structuredClone(pipeline)
}

/** The trimmed objective of a valid start request; throws what a person must change. */
export function validatedObjective(request: BuildReviewStartRequest): string {
  const reviewerCount = request.reviewers?.length ?? 1
  const rounds = request.maxReviewRounds ?? 1
  if (reviewerCount < 1 || reviewerCount > BUILD_REVIEW_MAX_REVIEWERS) {
    throw new Error(`Choose between 1 and ${BUILD_REVIEW_MAX_REVIEWERS} reviewers.`)
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > BUILD_REVIEW_MAX_ROUNDS) {
    throw new Error(`Choose between 1 and ${BUILD_REVIEW_MAX_ROUNDS} review rounds.`)
  }
  const objective = request.objective.trim()
  if (!objective) {
    throw new Error('Build + Review needs an objective.')
  }
  const problem = buildReviewSeatProblem(
    request.builder ?? BUILD_REVIEW_DEFAULT_BUILDER,
    request.reviewers ?? [request.reviewer ?? BUILD_REVIEW_DEFAULT_REVIEWER]
  )
  if (problem) {
    throw new Error(problem)
  }
  return objective
}

/**
 * Whether two seats may be the same model. "Agent default" is whatever that agent's host runs
 * by default, which this process cannot see, so it may be any model of that agent.
 */
function sameSeatModel(left: BuildReviewAgentChoice, right: BuildReviewAgentChoice): boolean {
  const model = (choice: BuildReviewAgentChoice) => choice.model?.trim().toLowerCase() || null
  const [a, b] = [model(left), model(right)]
  return a && b ? a === b : left.agent === right.agent
}

/** A retried run (possibly restored from before the policy) is admitted by the same rule. */
export function assertPipelineSeats(pipeline: BuildReviewPipelineSnapshot): void {
  const reviewers = (pipeline.reviewers ?? [pipeline.reviewer]).map((worker) => worker.choice)
  const problem = buildReviewSeatProblem(pipeline.builder.choice, reviewers)
  if (problem) {
    throw new Error(problem)
  }
}

/** The verdict policy of every other review path: no Gemini or unplaced judge, no self-review. */
export function buildReviewSeatProblem(
  builder: BuildReviewAgentChoice,
  reviewers: readonly BuildReviewAgentChoice[]
): string | null {
  for (const [index, reviewer] of reviewers.entries()) {
    if (!mayIssueVerdict(reviewer.agent, reviewer.model)) {
      return `Reviewer ${index + 1} (${reviewer.model ?? reviewer.agent}) may not issue a review verdict. Choose a Claude, Codex, Grok or other placed model.`
    }
    if (sameSeatModel(builder, reviewer)) {
      return `Reviewer ${index + 1} is the builder's own model. Choose a different model to review the build.`
    }
  }
  return null
}

/** A settled run back at its first step with the same request; its Activity log is kept. */
export function resetPipelineForRetry(pipeline: BuildReviewPipelineSnapshot): void {
  const reviewers = (pipeline.reviewers ?? [pipeline.reviewer]).map((worker) =>
    createWorker('reviewer', worker.choice)
  )
  pipeline.builder = createWorker('builder', pipeline.builder.choice)
  pipeline.reviewers = reviewers
  pipeline.reviewer = reviewers[0]!
  pipeline.runId = null
  delete pipeline.projectionTaskId
  pipeline.coordinatorTerminalHandle = null
  pipeline.round = 1
  pipeline.rounds = []
  pipeline.pendingQuestion = null
  pipeline.pendingQuestions = []
  pipeline.error = null
  pipeline.workspaceHold = null
  // The next execution decides its own placement; a refused Retry must not keep the old one.
  delete pipeline.placement
  setStage(pipeline, 'starting')
}

/** Which role ran a Dispatch of this pipeline, in any round; null when it is not one of them. */
export function roleOfDispatch(
  pipeline: BuildReviewPipelineSnapshot | undefined,
  dispatchId: string
): 'builder' | 'reviewer' | null {
  const rounds = pipeline?.rounds ?? []
  const workers = pipeline
    ? [
        pipeline.builder,
        pipeline.reviewer,
        ...(pipeline.reviewers ?? []),
        ...rounds.flatMap((round) => [round.builder, ...round.reviewers])
      ]
    : []
  return workers.find((worker) => worker.dispatchId === dispatchId)?.role ?? null
}

/** The worker a transcript read addresses; `reviewer` is 1-based, omitted means the current one. */
export function dispatchedWorkerForRead(
  pipeline: BuildReviewPipelineSnapshot,
  role: 'builder' | 'reviewer',
  reviewer: number | undefined
): BuildReviewWorkerSnapshot & { dispatchId: string } {
  const reviewers = pipeline.reviewers ?? [pipeline.reviewer]
  // Why the fallback: older clients read the current reviewer without naming a seat.
  const worker =
    role === 'builder'
      ? pipeline.builder
      : reviewer === undefined
        ? pipeline.reviewer
        : reviewers[reviewer - 1]
  if (!worker) {
    throw new Error(`Reviewer ${reviewer} does not exist on this pipeline.`)
  }
  if (!worker.dispatchId) {
    throw new Error(`The ${role} has not been dispatched yet.`)
  }
  return worker as BuildReviewWorkerSnapshot & { dispatchId: string }
}
