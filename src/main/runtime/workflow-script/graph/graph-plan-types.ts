import type { ContractRef } from '../../../../shared/decision-contracts/decision-contract-types'
import type { CouncilFinalCheck } from '../../../../shared/workflow-council-final-check'
import type { WorkflowOneAnswerRoute } from '../../../../shared/workflow-one-answer'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type {
  WorkflowImprovePrompts,
  WorkflowSpec,
  WorkflowStep
} from '../../../../shared/workflow-graph'
import type {
  WorkflowImproveRole,
  WorkflowImproveRound,
  WorkflowImproveTrail,
  WorkflowLoopView
} from '../../../../shared/workflow-improve-trail'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowReportRank } from '../../../../shared/workflow-report-ranking'
import type { WorkflowClaimRow } from '../../../../shared/workflow-claim-table'
import type { WorkflowProgramCall } from '../workflow-program-context'
import type { GRAPH_PROGRAM_REVISION } from '../workflow-program-revisions'
import type { GraphDiscoverFields } from './graph-discover-rules'
import type { GraphEvidenceFields, GraphEvidenceRequest } from './graph-evidence-check'
import type { GraphItem, GraphRawItem } from './graph-items'
import type { GraphStanding, GraphVerdict } from './graph-parse'
import type { GraphEarlierConfig, GraphText } from './graph-prompts'
import type { GraphWebRequest } from './graph-web-types'
import type { GraphWebCheck } from './graph-web-citation-marks'
import type { GraphWebSettling } from './graph-web-citations'
import type { GraphDegraded, GraphSeatFields, GraphSubstitution } from './graph-seat-types'
import type { GraphTarget } from './graph-target'
import type { GraphImproveCriterion, GraphImproveReflection } from './graph-improve-reflection'

export type { GraphDegraded, GraphSeatFields, GraphSubstitution } from './graph-seat-types'
export type { GraphTarget } from './graph-target'

/** The fields a workflow graph run adds to the frozen program snapshot. */
export type GraphSnapshotFields = {
  graphProgramRevision?: typeof GRAPH_PROGRAM_REVISION
  graph?: {
    spec: WorkflowSpec
    agentSeats: Record<string, string[]>
    /** The seat each Improve improver moves to in a frontier round; absent without one. */
    frontierSeats?: string[]
  } & GraphSeatFields
}

export type GraphConfig = GraphDiscoverFields &
  GraphEvidenceFields &
  GraphEarlierConfig & {
    spec: WorkflowSpec
    seats: ResolvedLocalWorkflowSeat[]
    /** The seat each step's agents run on, in agent order. */
    agentSeats: Record<string, string[]>
    access: 'workspace-read' | 'frozen'
    /** What the context folder holds (graphContextNote); absent when agents read the workspace. */
    workspaceNote?: string
    /** Answers a JEV judge call; absent, every JEV call fails and the model judges rank instead. */
    judgeWithJev?: (call: GraphCall) => Promise<GraphOutcome>
    /** Told once when the run settles, completed or failed: the judging record is written from it. */
    onSettled?: (plan: GraphPlan, outcomes: ReadonlyMap<string, GraphOutcome>) => void
    /** Runs an Improve loop's objective check on one version; absent, every check fails to run. */
    checkCandidate?: (call: GraphCall) => Promise<GraphOutcome>
    /** Find the best: JEV scores a whole pool of options (never an agent). */
    screenWithJev?: (call: GraphCall) => Promise<GraphOutcome>
    /** Find the best: GitHub's facts for a pool of repositories (never an agent). */
    fetchFacts?: (call: GraphCall) => Promise<GraphOutcome>
    /** Find the best: the person's GitHub search, run once by the host (never an agent). */
    harvestGitHub?: (call: GraphCall) => Promise<GraphOutcome>
    /** One-answer routing: JEV's yes/no reading of the question (never an agent). */
    routeWithJev?: (call: GraphCall) => Promise<GraphOutcome>
    /** Discover: the app checks the finders' quotes against the workspace files (never an agent). */
    checkEvidence?: (call: GraphCall) => Promise<GraphOutcome>
    /** A review's `jevVerify`: JEV's yes/no per item over its code, recorded only (never an agent). */
    verifyWithJev?: (call: GraphCall) => Promise<GraphOutcome>
    /** The pages a run's readers cite, read once by the app and kept (never an agent). */
    readWeb?: (call: GraphCall) => Promise<GraphOutcome>
    /**
     * Find the best: the planning rules the run was admitted under (host.findRules). Absent on
     * runs admitted before rules 2, which replay as they ran: without GitHub facts.
     */
    findRules?: number
    /** The web rules the run was admitted under (host.webRules); absent, it never reads pages. */
    webRules?: number
    /** Frozen opt-in: unresolved Improve rounds cannot establish a plateau. */
    improveUnresolvedRounds?: true
    /** Improve rules the run was admitted under (IMPROVE_RULES); absent on older runs. */
    improveRules?: number
    /** Frozen at admission (graph.frontierSeats): each improver's seat in a frontier round. */
    improveFrontierSeats?: string[]
    /** Decision rules the run was admitted under (DECISION_RULES); absent: LEGACY_CONTRACTS. */
    decisionRules?: number
    /** Each JEV decision point's contract, frozen at admission. */
    contracts?: Readonly<Record<string, ContractRef>>
    /** A call the finishing run refused (graph-checkpoint.ts): it settles as skipped, not failed. */
    refused?: (callId: string) => boolean
    /** Under seat rules: where a call that failed at launch runs again, once; none, it is lost. */
    substitute?: (
      call: GraphCall,
      failure?: string,
      crossFamily?: boolean
    ) => Promise<GraphSubstitution | undefined>
  } & GraphSeatFields

/**
 * Rules 2 adds repository facts; rules 3 adds paged screening and criterion leaders; rules 4 adds
 * Scan's structured items; rules 5 adds the GitHub search that harvests repositories into the pool.
 */
export const FIND_RULES = 5

/** The Find rules a run was admitted under, read defensively: older snapshots have none. */
export function graphFindRules(snapshot: object): { findRules?: number } {
  const rules = (snapshot as { host?: { findRules?: unknown } }).host?.findRules
  return typeof rules === 'number' ? { findRules: rules } : {}
}

/**
 * Scan's structured items (itemDetails or an import receipt) only ever came from this PR's own
 * unmerged commits before findRules 4: no released build ever admitted one that way. Such a run
 * can never be resumed with today's formatter without changing what was actually screened and
 * judged, so recovery and replay refuse it outright rather than replay it differently or silently
 * upgrade it. A pre-Scan run (plain string items, rules 2/3 or absent) is unaffected and replays
 * byte-identically, as before.
 */
export function assertScanReplaySupported(spec: WorkflowSpec, snapshot: object): void {
  const find = spec.find
  const admittedRules = graphFindRules(snapshot).findRules ?? 0
  if (find && (find.itemDetails || find.importReceipt) && admittedRules < 4) {
    throw new Error(
      "This run was made by a development build of Scan and can't be resumed; start it again."
    )
  }
}

/** The repositories a Find the best pool names, by option key. */
export type GraphFactsRequest = { repos: { key: string; owner: string; repo: string }[] }

/** The person's GitHub search, run once by the host; `max` repositories at most come back. */
export type GraphHarvestRequest = { query: string; max: number }

/**
 * A run that searched GitHub can only be replayed by a build whose planner plans that same call.
 * Rather than replay it as a run that never searched (a different pool, judged differently),
 * recovery and replay refuse it outright, the way a development-build Scan run is refused above.
 */
export function assertHarvestReplaySupported(spec: WorkflowSpec, snapshot: object): void {
  if (spec.find?.harvest && (graphFindRules(snapshot).findRules ?? 0) < 5) {
    throw new Error(
      "This run searched GitHub under rules this build does not know, so it can't be resumed; start it again."
    )
  }
}

/** Find the best's screen: JEV scores every option against the rubric. */
export type GraphScreenRequest = {
  task: string
  rubric: string
  candidates: { id: string; text: string }[]
  /** Under decision rules: the contract the screen is judged by. */
  contract?: ContractRef
}

/**
 * A review's `jevVerify` (graph-jev-verify.ts): every item the review will see, with the file and
 * line it cites; the host reads the code. Its answer is `{ probabilities }`, by item key.
 */
export type GraphVerifyRequest = {
  scope: string
  items: {
    key: string
    title: string
    location: string
    detail: string
    file?: string
    line?: number
  }[]
  contract?: ContractRef
  /** Live only: the probability at which an item the reviewers left unverified is confirmed. */
  confirmAt?: number
  /** Live only (from discover-verify@3): the probability at or below which it is set aside. */
  rejectAt?: number
}

/** One-answer routing: the question JEV reads; its answer is `{ noul }` or `{ error }`. */
export type GraphRouteRequest = { question: string; contract?: ContractRef }

/** The seat id an objective check is recorded under; it never runs an agent. */
export const GRAPH_CHECK_SEAT_ID = 'check'

/**
 * One version to check: the command the person typed and the version itself. Rules-2 keys are
 * present only when set, so a recorded check from older rules keeps its digest.
 */
export type GraphCheckRequest = {
  command: string
  candidate: string
  /** SCORE counts only as the last non-empty line of the output. */
  scoreLastLine?: true
  /** Run once per practice case, the case replacing `{case}`. */
  cases?: string[]
  timeoutSeconds?: number
  /** A change to the code: the version's diff is applied in a private copy, where the check runs. */
  apply?: 'patch'
  prepare?: string
  protect?: string[]
  /** "No change": the code as it is, nothing applied (Improve's first incumbent). */
  unchanged?: true
  /** The final test kept back: its cases, run once in a fresh private copy never reused. */
  sealed?: true
}

/** What a check found: passed (exit 0), the score it printed, and the end of its output. */
export type GraphCheckResult = {
  passed: boolean
  score?: number
  detail: string
  /**
   * Practice cases: how many there were, passed, and could not run (never counted as passed);
   * `passing` numbers the cases that passed from 0, so versions with other strengths are found.
   */
  cases?: { total: number; passed: number; unavailable: number; passing?: number[] }
  /** The command could not run at all (not found, no workspace): a gap, never a quiet fail. */
  unavailable?: true
  /** A change to the code: calls it adds that end the process early (flagged, never refused). */
  exits?: string[]
}

/** The seat id a JEV ballot is recorded under; it never runs an agent. */
export const GRAPH_JEV_SEAT_ID = 'jev'

/** What a JEV judge is asked: the task, the step's instruction (its rubric) and the answers. */
export type GraphJevRequest = {
  method: 'auto' | 'rubric' | 'pairwise'
  task: string
  instruction: string
  candidates: { label: string; markdown: string }[]
  /** Improve: the best version so far, which JEV's top answer must clearly beat to be sure. */
  incumbent?: string
  /** Under decision rules: the contract whose confidence policy the ballot is judged by. */
  contract?: ContractRef
}
export type GraphTask = { prompt: string; evidence: string }
/**
 * A settled call: the accepted value, or a failure after every attempt the run allows. `skipped`:
 * the run was finishing (Finish now, Max agents) and never started it.
 */
/** `lost`: a call that failed at launch and no other seat answered for it (why it failed). */
export type GraphOutcome =
  | { value: unknown; substitute?: GraphSubstitution }
  | { failed: true; skipped?: true; lost?: string; substitute?: GraphSubstitution }

/** A host-answered call that failed but kept its explanation (a JEV screen) carries `value.error`. */
export function graphValueError(outcome: GraphOutcome): string | undefined {
  const value = 'value' in outcome ? (outcome.value as { error?: unknown } | null) : undefined
  return value && typeof value.error === 'string' ? value.error : undefined
}

export type GraphCall = WorkflowProgramCall & {
  stepId: string
  round: number
  itemKey?: string
  agentIndex: number
  /** A JEV ballot, answered by `GraphConfig.judgeWithJev` rather than an agent. */
  jev?: GraphJevRequest
  /** An objective check, answered by `GraphConfig.checkCandidate` rather than an agent. */
  check?: GraphCheckRequest
  screen?: GraphScreenRequest
  facts?: GraphFactsRequest
  /** The person's GitHub search, answered by `GraphConfig.harvestGitHub` rather than an agent. */
  harvest?: GraphHarvestRequest
  route?: GraphRouteRequest
  /** A shadow JEV verify, answered by `GraphConfig.verifyWithJev` rather than an agent. */
  verify?: GraphVerifyRequest
  evidence?: GraphEvidenceRequest
  /** The run's web pages, answered by `GraphConfig.readWeb` rather than an agent. */
  web?: GraphWebRequest
}

export type GraphCallView = {
  id: string
  stepId: string
  round: number
  itemKey?: string
  agentIndex: number
  seatId: string
  angle?: string
  status: 'ready' | 'done' | 'failed'
  /** Failed because the finishing run never started it. */
  skipped?: true
  /** A JEV ballot rather than an agent's. */
  jev?: true
  verdict?: GraphVerdict
  ranking?: string[]
  items?: number
}

export type GraphStepState = 'waiting' | 'active' | 'done' | 'gaps' | 'failed' | 'not-run' | 'empty'
export type GraphNamedText = GraphText & {
  agentIndex: number
  seatId: string
  callId: string
  itemKey?: string
}
export type GraphCandidate = {
  label: string
  seatId: string
  name: string
  markdown: string
  /** The step and agent that wrote it: which seat (and system prompt) the judging record credits. */
  source?: { stepId: string; agentIndex: number }
  /** Improve: the best version so far defending its place, not a new answer from its seat. */
  incumbent?: true
}
export type GraphStepRun = {
  finalCheck?: CouncilFinalCheck
  finalCheckAnswer?: string
  stepId: string
  round: number
  state: GraphStepState
  reason?: string
  calls: GraphCallView[]
  texts?: GraphNamedText[]
  items?: GraphItem[]
  /** Reports of items an earlier round found, by that item's key (applied after the loop). */
  /** `from`: the call that reported it, so a merged copy knows every finder. */
  knownReports?: { key: string; report: GraphRawItem; from?: string }[]
  targets?: GraphTarget[]
  /** Running: items whose reviews are all in and confirmed them (graph-review-target.ts). */
  verifiedEarly?: GraphTarget[]
  verdicts?: (GraphVerdict | null)[]
  approved?: boolean
  candidates?: GraphCandidate[]
  standings?: GraphStanding[]
  setAside?: number
  /** Inputs the prompt budget cut, one line each; every one is a gap of the run. */
  cuts?: string[]
  /** A comparison by criterion's overall round: each rubric line's leaders and who judged it. */
  criteria?: {
    criterion: string
    leaders: string[]
    judgedBy: ('jev' | 'models')[]
    /** Why the line was not settled; it is left out of the overall order. */
    unsettled?: string
  }[]
  /** A shortlist JEV could not rank (graph-shortlist.ts): why, a gap of the run. */
  unranked?: string
  /** Rank: JEV answered but was not sure, so the model judges stepped in. */
  jevUnsure?: true
  /** Rank: that unsure JEV ballot still counted with the model judges' ballots. */
  jevCounted?: true
  /** The app's checks of every web citation its answers make; each failed one is a gap. */
  webChecks?: GraphWebCheck[]
  /** The round's JEV verify call; kept off `calls`, so it is never a gap (live waits on it). */
  jevVerifyCall?: string
  /** Live JEV verify held these undecided, by key: merged reports it did not read. */
  jevHeld?: Record<string, number>
  notes: string[]
}

export type GraphLoopState = WorkflowLoopView
export type GraphImproveRole = WorkflowImproveRole
export type GraphImproveRound = WorkflowImproveRound
export type GraphImproveTrail = WorkflowImproveTrail

/** One improver's brief: its role, the best version so far and what the judges said about it. */
export type GraphImproveBrief = {
  role: GraphImproveRole
  round: number
  best?: { markdown: string; name: string; round: number }
  /**
   * Several versions to build on: `best` holds this improver's parent instead of the best, kept
   * because it passes cases the best fails, or as the strongest different approach.
   */
  parent?: 'cases' | 'alternative'
  /** A promising line that takes a different approach, kept for the explorers to develop. */
  alternative?: { markdown: string; name: string; round: number }
  /** What the judges count as better work (the person's "what good means", else the default). */
  rubric?: string
  /** The person's wording for Improve's instructions, where they changed it. */
  prompts?: WorkflowImprovePrompts
  feedback?: { bestLabel?: string; ballots: GraphText[]; weakest?: GraphImproveCriterion[] }
  /** Rules 3: the best version's weakest criteria and what earlier rounds tried that lost. */
  reflection?: GraphImproveReflection
  /** The loop's objective check, so every improver knows how its version will be tested. */
  checkCommand?: string
  /** The objective check on the best version: what it must still fix, or the score to beat. */
  check?: GraphCheckResult
  /** Improve rules 2 with a check: the practice cases each version runs on (maybe none). */
  measuredCheck?: { cases: string[]; predict?: true }
  /**
   * Each version is a change to the code: the paths it may not touch, and whether "No change"
   * (the code as it is) still holds, so `check` is the code's own result.
   */
  change?: { protect: string[]; unchanged: boolean }
}

export type GraphRunOutcome = {
  state: 'completed' | 'failed'
  error?: string
  gaps: string[]
  /** Steps lost calls no other seat could take (graph-seat-substitution.ts). */
  degraded?: GraphDegraded
  /** `ranking`: a ranked write-up's order of the reviewed results (graph-report-ranking.ts). */
  final?: {
    stepId: string
    markdown: string
    ranking?: WorkflowReportRank[]
    /** A run that reads pages: the claims table's rows, each with the app's own quote checks. */
    claims?: WorkflowClaimRow[]
    /** The app's own part (claims table, Sources), always rendered apart from `markdown`. */
    appendix?: string
  }
}

export type GraphPlan = {
  runs: Record<string, GraphStepRun[]>
  calls: GraphCall[]
  ready: GraphCall[]
  loop?: GraphLoopState
  find?: WorkflowFindTrail
  /** One-answer routing: what JEV decided, once it has. */
  route?: WorkflowOneAnswerRoute
  notes: string[]
  /** Every call the plan knows about has an outcome, so the run can finish. */
  settled: boolean
  outcome?: GraphRunOutcome
  /** A run that reads pages: what the view needs to settle an item after merging its reports. */
  web?: GraphWebSettling
}

/** What a step hands the steps that read it. */
export type GraphStepOutput =
  | { status: 'pending' }
  | { status: 'failed' | 'not-run'; reason: string; run?: GraphStepRun }
  | GraphOkOutput
export type GraphOkOutput = { status: 'ok'; run: GraphStepRun; callIds: string[] }

/**
 * Reviews and rankings advise the steps that read them: when one fails outright, a later Do or
 * Synthesize step goes on without it and the run reports the gap. Work (Do, Synthesize) is
 * required: when it fails, everything that reads it is not run.
 */
export const graphStepIsAdvisory = (step: WorkflowStep | undefined): boolean =>
  step?.kind === 'review' || step?.kind === 'rank'

const MINUTE = 60_000
export const GRAPH_TIMEOUTS: Record<WorkflowStep['kind'], number> = {
  do: 20 * MINUTE,
  review: 10 * MINUTE,
  rank: 10 * MINUTE,
  synthesize: 15 * MINUTE
}

export const graphPlural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

export function graphDoneCallIds(run: GraphStepRun): string[] {
  return run.calls.filter((view) => view.status === 'done').map((view) => view.id)
}

/** A search that ran out of rounds before a round came back complete with nothing new. */
export function graphUnfinishedSearch(title: string, rounds: number): string {
  return `${title} stopped after ${graphPlural(rounds, 'round')} without a complete round that found nothing new, so more may remain.`
}
