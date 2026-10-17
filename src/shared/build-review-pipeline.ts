/**
 * Build + Review pipeline: the desktop-owned coordinator that runs one
 * orchestration Run with a builder and one or more reviewers, repeating
 * repairs and reviews until everyone approves or the round limit is reached.
 *
 * It is an executor pattern, not a business authority (SYSTEMS.md, 2026-09-08):
 * bound to an omnios card (`hubTaskId`) it projects every verdict to the card
 * as evidence and "approved" means the change is a candidate for the hub's
 * verification. Acceptance and completion are decided on the card, never here.
 *
 * Contract shared by main (service + RPC), preload (change events) and the
 * renderer (dialog, page, sidebar). Keep this file free of runtime imports.
 */

import type { CheckedReviewFinding } from './review-findings'
import type { WorkflowPlacement, WorkflowRunsOn } from './local-workflow-placement'
import { REVIEW_RUBRIC_PRESETS, type ReviewRubric } from './review-rubrics'
import type { SessionEffortParity } from './session-effort-parity'

export const BUILD_REVIEW_RPC = {
  start: 'buildReview.start',
  list: 'buildReview.list',
  show: 'buildReview.show',
  cancel: 'buildReview.cancel',
  reply: 'buildReview.reply',
  readWorker: 'buildReview.readWorker',
  retry: 'buildReview.retry',
  releaseWorkspace: 'buildReview.releaseWorkspace',
  /** Answers only on hosts that place Build + Review runs; a client refuses a fleet Start where it is unknown. */
  placementSupport: 'buildReview.placementSupport'
} as const

/** `hosts`: the host takes `runsOnHost`; absent on hosts from before named hosts. */
export type BuildReviewPlacementSupportResult = {
  runsOn: readonly WorkflowRunsOn[]
  hosts?: true
}

/** Preload/IPC channel carrying `BuildReviewChangedPayload` main → renderer. */
export const BUILD_REVIEW_CHANGED_CHANNEL = 'buildReview:changed'

export type BuildReviewAgentChoice = {
  /** TUI agent id known to the runtime, e.g. 'codex' | 'claude' | 'grok'. */
  agent: string
  /** Opaque provider model id, e.g. 'opus', 'gpt-5.5'. */
  model?: string
  /** Reasoning effort when the agent/model supports it, e.g. 'high', 'xhigh'. */
  effort?: string
  /** A reviewer's rubric, frozen on the run when it starts; ignored for the builder. */
  rubric?: ReviewRubric
}

export const BUILD_REVIEW_DEFAULT_BUILDER: BuildReviewAgentChoice = { agent: 'codex' }
export const BUILD_REVIEW_DEFAULT_REVIEWER: BuildReviewAgentChoice = {
  agent: 'claude',
  model: 'opus',
  effort: 'high'
}
export const BUILD_REVIEW_DEFAULT_REVIEWER_COUNT = 3
/**
 * The setup's starting panel: three lineages. Seat pinning moves an unchosen seat off the
 * builder's model or a model already seated, so the three stay three different models.
 */
export const BUILD_REVIEW_DEFAULT_REVIEWERS: readonly BuildReviewAgentChoice[] = [
  { ...BUILD_REVIEW_DEFAULT_REVIEWER, rubric: REVIEW_RUBRIC_PRESETS[0] },
  { agent: 'grok', rubric: REVIEW_RUBRIC_PRESETS[0] },
  { agent: 'codex', rubric: REVIEW_RUBRIC_PRESETS[0] }
]

export type BuildReviewStartRequest = {
  /** Runtime worktree selector, normally `id:<repo-id>::<path>`. */
  worktree: string
  /** What to build, in the user's words. Becomes the Run objective and the builder task. */
  objective: string
  builder?: BuildReviewAgentChoice
  reviewer?: BuildReviewAgentChoice
  reviewers?: BuildReviewAgentChoice[]
  maxReviewRounds?: number
  /** Extra instructions appended to the reviewer brief (optional). */
  reviewFocus?: string
  /**
   * `required` (the default): a blocker withholds approval unless a complete check cleared it.
   * `off`: the reviewer's verdict alone decides, as before.
   */
  evidence?: 'required' | 'off'
  /**
   * omnios card the work belongs to (`btk_…`). Binds the Run, the builder and
   * every reviewer to the card and projects verdicts to it as evidence.
   * Without it the pipeline is ad hoc local work and records nothing on omnios.
   */
  hubTaskId?: string
  /**
   * Where the workers run (docs/reference/workflow-fleet-placement.md): the fleet by default,
   * this computer as the explicit opt-in. Absent reads as fleet; a host from before placement
   * ignores it and runs here as it always did.
   */
  runsOn?: WorkflowRunsOn
  /**
   * "Run on: <host>": a fleet host by name. Sent only to a host whose `placementSupport` answers
   * `hosts: true`, since `start` strips unknown keys and an older host would choose by itself.
   */
  runsOnHost?: string
  /** The execution host id the person picked (`ssh:<target-id>` or `local`), recorded with the run. */
  runsOnHostId?: string
  /** A person's reason to run on a named host above the load bound; refused for agent callers. */
  forceHost?: string
  /** Who asked an agent to start this run, and their words; required from agent callers. */
  requestedBy?: string
  request?: string
}

export type BuildReviewStage =
  | 'starting'
  | 'building'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BuildReviewWorkerStatus = 'pending' | 'starting' | 'running' | 'succeeded' | 'failed'

export type BuildReviewWorkerReport = {
  subject: string
  body: string
  outcome: 'succeeded' | 'failed'
  filesModified: string[]
  reportPath: string | null
  reportedAt: string
}

export type BuildReviewWorkerSnapshot = {
  role: 'builder' | 'reviewer'
  choice: BuildReviewAgentChoice
  /**
   * What this worker was asked to run at, beside what its start receipt reported. Why
   * per worker: `choice` alone is only the request, so a reviewer that started at a
   * lower effort than the pipeline asked for was indistinguishable from one that got
   * what it asked for — and its verdict read just as authoritative.
   */
  effortParity?: SessionEffortParity
  status: BuildReviewWorkerStatus
  taskId: string | null
  dispatchId: string | null
  /** Runtime terminal handle of the worker's agent terminal; focusable from the UI. */
  terminalHandle: string | null
  /** Set once that terminal is known closed, so nothing offers to open it. */
  terminalClosed?: boolean
  report: BuildReviewWorkerReport | null
  /** A reviewer's findings with what the host saw checking them; null when none could be read. */
  findings?: CheckedReviewFinding[] | null
  error: string | null
  /**
   * The startup prompt this worker is stuck on, when only a person can answer it: a runtime
   * blocker id (`codex-hooks-review-prompt`, `codex-trust-workspace`, …), `claude-folder-trust`
   * or `agent-prompt-stalled`. Its terminal is kept open so the person can answer.
   */
  startupBlocker?: string
}

/** One reason a workspace is still reserved, in terms a person can act on. */
export type BuildReviewWorkspaceHoldItem = {
  /**
   * `terminal-open`: a finished worker's terminal is still open. `maybe-working`: a worker whose
   * start failed after its task may have landed, so its agent may be working in that terminal.
   * `worker-running`: a worker has not settled. `unverified`: a worker start never reported back,
   * or its record cannot be checked. `run-active`: that run is still going. `other-window`:
   * another app instance holds it.
   */
  kind:
    | 'terminal-open'
    | 'maybe-working'
    | 'worker-running'
    | 'unverified'
    | 'run-active'
    | 'other-window'
  role: 'builder' | 'reviewer' | null
  dispatchId: string | null
  terminalHandle: string | null
  /**
   * True when Release workspace can close this terminal itself (the run still owns it). Absent,
   * the terminal frees the workspace once it is closed, and Release could not do that.
   */
  releasable?: boolean
}

/** A settled run still holding its workspace, or the earlier run that blocks this one. */
export type BuildReviewWorkspaceHold = {
  pipelineId: string
  runId: string | null
  items: BuildReviewWorkspaceHoldItem[]
}

export type BuildReviewEventKind =
  | 'info'
  | 'worker_started'
  | 'worker_done'
  | 'question'
  | 'reply'
  | 'escalation'
  | 'heartbeat'
  | 'error'

export type BuildReviewEvent = {
  at: string
  kind: BuildReviewEventKind
  role: 'builder' | 'reviewer' | 'pipeline'
  text: string
}

export type BuildReviewPendingQuestion = {
  messageId: string
  role: 'builder' | 'reviewer'
  question: string
  options: string[]
  askedAt: string
  /** The asking worker's dispatch; reviewers run together, so role alone is ambiguous. */
  dispatchId?: string
}

export type BuildReviewPipelineSnapshot = {
  id: string
  runId: string | null
  /** Execution projection returned by a card-bound Run; absent on older runtimes. */
  projectionTaskId?: string
  worktree: string
  worktreeId: string | null
  objective: string
  reviewFocus: string | null
  /** Bound omnios card, or null for ad hoc local work. */
  hubTaskId: string | null
  stage: BuildReviewStage
  coordinatorTerminalHandle: string | null
  builder: BuildReviewWorkerSnapshot
  reviewer: BuildReviewWorkerSnapshot
  reviewers?: BuildReviewWorkerSnapshot[]
  maxReviewRounds?: number
  round?: number
  rounds?: BuildReviewRound[]
  /** Blockers withhold approval unless a complete check cleared them; absent on runs from before, where verdicts decide. */
  evidenceRequired?: boolean
  /** The oldest of `pendingQuestions`, kept for clients that show one question. */
  pendingQuestion: BuildReviewPendingQuestion | null
  /** Every open worker question; parallel reviewers may each ask one. */
  pendingQuestions?: BuildReviewPendingQuestion[]
  events: BuildReviewEvent[]
  error: string | null
  /** Why the workspace is still reserved; absent or null when nothing holds it. */
  workspaceHold?: BuildReviewWorkspaceHold | null
  /** The request's placement choice; absent on runs from before placement, which ran here. */
  runsOn?: WorkflowRunsOn
  /** Where this execution was placed before any worker started; absent until then or on refusal. */
  placement?: WorkflowPlacement
  /** The named host, its picked execution host id and forced reason, as the request gave them. */
  runsOnHost?: string
  runsOnHostId?: string
  forceHost?: string
  /** Who asked an agent to start this run, in their words; absent when a person started it. */
  requestedBy?: string
  request?: string
  createdAt: string
  updatedAt: string
}

export type BuildReviewRound = {
  number: number
  builder: BuildReviewWorkerSnapshot
  reviewers: BuildReviewWorkerSnapshot[]
}

export const BUILD_REVIEW_MAX_REVIEWERS = 8
export const BUILD_REVIEW_MAX_ROUNDS = 10

const UPPER_CASE_LABEL = /^VERDICT\s*:/
const LABELLED_VERDICT = /^([A-Za-z]+)\s*:\s*_*(APPROVE|REQUEST_CHANGES)_*$/

/**
 * One line without the markdown a model wraps a verdict in: bold/italic/code marks, a
 * blockquote, heading or list marker, and trailing punctuation. Underscores are only trimmed at
 * the ends because REQUEST_CHANGES carries one.
 */
function plainVerdictLine(line: string): string {
  return line
    .replace(/[*`]/g, '')
    .replace(/^(?:\s*(?:>|#{1,6}(?=\s)|[-+](?=\s)|\d+[.)](?=\s)))+/, '')
    .trim()
    .replace(/^_+|_+$/g, '')
    .replace(/[\s.!;,]+$/, '')
    .trim()
}

/**
 * What one plain line says as a verdict: a verdict, `invalid` for a `VERDICT:` line naming
 * anything else, or null for any other line. The label may be in any case only when the value is
 * exactly one of the two verdicts (`**Verdict:** APPROVE`); otherwise prose such as "Verdict:
 * looks fine" would count as a second verdict line and void the real one.
 */
function lineVerdict(line: string): 'APPROVE' | 'REQUEST_CHANGES' | 'invalid' | null {
  const labelled = LABELLED_VERDICT.exec(line)
  if (labelled && labelled[1]!.toUpperCase() === 'VERDICT') {
    return labelled[2] === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES'
  }
  return UPPER_CASE_LABEL.test(line) ? 'invalid' : null
}

/**
 * The reviewer's single verdict. Why tolerant: reviewers are told to end with a plain
 * `VERDICT: …` line, but models decorate it (`**VERDICT: APPROVE**`, `> VERDICT: APPROVE`,
 * `VERDICT: REQUEST_CHANGES.`) and an exact-match reader failed whole runs on that. Still exactly
 * one verdict line: two, or one naming anything else, is no verdict.
 */
export function reviewVerdict(
  body: string | null | undefined
): 'APPROVE' | 'REQUEST_CHANGES' | null {
  const [verdict, ...others] = (body ?? '')
    .split(/\r?\n/)
    .map((line) => lineVerdict(plainVerdictLine(line)))
    .filter((line) => line !== null)
  return verdict && verdict !== 'invalid' && others.length === 0 ? verdict : null
}

export type BuildReviewStartResult = { pipeline: BuildReviewPipelineSnapshot }
export type BuildReviewListResult = { pipelines: BuildReviewPipelineSnapshot[] }
export type BuildReviewShowParams = { id: string }
export type BuildReviewShowResult = { pipeline: BuildReviewPipelineSnapshot }
export type BuildReviewCancelParams = { id: string }
export type BuildReviewCancelResult = { pipeline: BuildReviewPipelineSnapshot }
export type BuildReviewReplyParams = { id: string; messageId: string; body: string }
export type BuildReviewReplyResult = { pipeline: BuildReviewPipelineSnapshot }
export type BuildReviewRetryParams = { id: string }
export type BuildReviewReleaseWorkspaceParams = { id: string }
/** Bounded read of a worker's transcript/terminal via orchestration.workerRead. */
export type BuildReviewReadWorkerParams = {
  id: string
  role: 'builder' | 'reviewer'
  /** 1-based reviewer seat for `role: 'reviewer'`; omitted reads the current reviewer. */
  reviewer?: number
  cursor?: string | number
  limit?: number
}

export type BuildReviewChangedPayload = {
  pipelineId: string
  stage: BuildReviewStage
}

export function isBuildReviewActive(stage: BuildReviewStage): boolean {
  return stage === 'starting' || stage === 'building' || stage === 'reviewing'
}

/** The current round's reviewers; a snapshot read from an older store may lack them. */
function currentBuildReviewReviewers(
  pipeline: BuildReviewPipelineSnapshot
): BuildReviewWorkerSnapshot[] {
  return (pipeline.reviewers ?? [pipeline.reviewer]).filter(Boolean)
}

/**
 * A run still going that waits on the person: a worker's open question, or a startup question
 * (folder trust, a hooks review) only they can answer in the worker's terminal.
 */
export function buildReviewWaitsOnPerson(pipeline: BuildReviewPipelineSnapshot): boolean {
  return (
    isBuildReviewActive(pipeline.stage) &&
    (Boolean(pipeline.pendingQuestion) ||
      [pipeline.builder, ...currentBuildReviewReviewers(pipeline)]
        .filter(Boolean)
        .some(
          (worker) =>
            Boolean(worker.startupBlocker) &&
            (worker.status === 'starting' || worker.status === 'running')
        ))
  )
}

/** The pipeline's own reason for stopping at its round limit (`build-review-rounds.ts`). */
const ROUND_LIMIT_ERROR = /^Review limit reached\b/

/**
 * A run that used its last round while its reviewers still asked for changes. The pipeline
 * files it as failed so Retry stays available, but it is an outcome of its own: the work was
 * reviewed and the findings are the person's to take on. Only that stop counts: every reviewer
 * of the round gave one valid verdict, one asked for changes, and nothing else ended the run.
 */
export function buildReviewEndedWithChangesRequested(
  pipeline: BuildReviewPipelineSnapshot
): boolean {
  if (
    pipeline.stage !== 'failed' ||
    !ROUND_LIMIT_ERROR.test(pipeline.error ?? '') ||
    (pipeline.round ?? 1) < (pipeline.maxReviewRounds ?? 1)
  ) {
    return false
  }
  const verdicts = currentBuildReviewReviewers(pipeline).map((reviewer) =>
    reviewer.status === 'succeeded' ? reviewVerdict(reviewer.report?.body) : null
  )
  return verdicts.length > 0 && !verdicts.includes(null) && verdicts.includes('REQUEST_CHANGES')
}
