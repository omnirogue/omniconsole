import type { LocalWorkflowPreset } from './local-workflow-draft'
import type { LocalWorkflowGraphRun } from './local-workflow-graph-view'
import type { LocalWorkflowRoute, ResolvedLocalWorkflowSeat } from './local-workflow-seats'
import type { WorkflowWebCheck } from './workflow-graph-web'
import type { LocalWorkflowCallLive } from './local-workflow-call-live'
import type { LocalWorkflowResult } from './local-workflow-result'
import type { WorkflowPlacement } from './local-workflow-placement'

/** `finish` is never listed in `actions`: a host that supports it sets `canFinish`. */
export type LocalWorkflowAction = 'pause' | 'resume' | 'stop' | 'retry' | 'finish'
export type LocalWorkflowRunState =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'recovery_required'
  | 'budget_paused'

export type LocalWorkflowSource = { ref: string; description: string }
export type LocalWorkflowCouncilReview = {
  reviewer: string
  ranking: string[]
  assessments: { label: string; strengths: string; weaknesses: string }[]
}
export type LocalWorkflowCouncilRanking = {
  label: string
  model: string
  score: number
  votes: number
}
/** `cli`: the provider's own bill for the attempt; `table`: list prices times its tokens. */
export type LocalWorkflowCallCost = { usd: number; source: 'cli' | 'table'; partial?: true }
export type LocalWorkflowCallView = {
  id: string
  stageId: string
  seatId?: string
  /** Provider route, for AgentIcon. */
  agent?: LocalWorkflowRoute
  seatLabel: string
  /** Friendly model name, e.g. "Claude Opus 5". */
  modelLabel?: string
  model: string
  effort: string | null
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unverifiable'
  attempt: number
  attemptLimit: number
  transport: 'headless' | 'terminal'
  /** Working-agent calls: the worker's own terminal, while its Dispatch has not released it. */
  terminalHandle?: string
  /** Logs are loaded on demand through localWorkflow.readCall; pushed views leave them empty. */
  stdout: string
  stderr: string
  outputTruncated: boolean
  resultMarkdown?: string
  /** A run that reads pages: the app's own check of each web quote in the answer. */
  webChecks?: WorkflowWebCheck[]
  error?: string
  startedAt?: number
  endedAt?: number
  tokens?: { input: number; output: number }
  /** Every priced terminal attempt, including failures; partial when a launched bill is missing. */
  cost?: LocalWorkflowCallCost
  live?: LocalWorkflowCallLive
}

export type LocalWorkflowSeatView = {
  seatId: string
  agent: LocalWorkflowRoute
  model: string
  modelLabel: string
  effort: string | null
}

/** Council revision 6 (Karpathy llm-council); older revisions are mapped into the same shape. */
export type LocalWorkflowCouncilRun = {
  members: (LocalWorkflowSeatView & {
    /** Stable anonymous label, e.g. "Response A". */
    label: string
    /** False for answer-only members (Google lineage never ranks). */
    votes: boolean
    answerCallId: string
  })[]
  chair?: LocalWorkflowSeatView
  ballots: {
    reviewerSeatId: string
    callId: string
    /** The reviewer's own words, still using anonymous labels; the renderer de-anonymises. */
    evaluation: string
    /** Parsed labels, best first. Empty when nothing could be parsed. */
    ranking: string[]
  }[]
  /** Average 1-based rank from other members' ballots; empty until a ballot lands. */
  standings: { label: string; seatId: string; averageRank: number; votes: number; place: number }[]
  selfVotesExcluded: boolean
}

export type LocalWorkflowDiscoverSeverity = 'low' | 'medium' | 'high' | 'critical'
export type LocalWorkflowDiscoverVerdict = 'real' | 'refuted' | 'unjudged'
export type LocalWorkflowDiscoverFinding = {
  id: string
  title: string
  /** "path:line" or "path:line-end". */
  location: string
  severity: LocalWorkflowDiscoverSeverity
  lens: string
  area: string
  round: number
  foundBy: LocalWorkflowSeatView
  /** Markdown: trigger, failure scenario and evidence. */
  markdown: string
  status: 'verifying' | 'confirmed' | 'refuted' | 'unverified'
  votes: {
    lens: string
    seat: LocalWorkflowSeatView
    state: 'pending' | 'running' | 'done' | 'failed'
    verdict?: LocalWorkflowDiscoverVerdict
    reason?: string
  }[]
  /** Set when this finding repeats an earlier one; duplicates are not verified again. */
  duplicateOf?: string
}
export type LocalWorkflowDiscoverRun = {
  areas: { name: string; files: string[]; why: string }[]
  lenses: string[]
  round: number
  maxRounds: number
  findings: LocalWorkflowDiscoverFinding[]
  counts: {
    found: number
    duplicates: number
    verifying: number
    confirmed: number
    refuted: number
    unverified: number
  }
  report?: {
    summary: string
    items: {
      rank: number
      title: string
      location: string
      severity: LocalWorkflowDiscoverSeverity
      scenario: string
      fix: string
      findingIds: string[]
      parallelSafe: boolean
    }[]
  }
  /** Work a cap dropped; shown to the user (no silent caps). */
  dropped: string[]
}

export type {
  LocalWorkflowEvidenceStatus,
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun,
  LocalWorkflowGraphState,
  LocalWorkflowGraphVerdict
} from './local-workflow-graph-view'

/** Host projection only: absence of an action means that action is unavailable. */
export type LocalWorkflowView = {
  executionId: string
  fence: number
  sequence: number
  preset: LocalWorkflowPreset
  state: LocalWorkflowRunState
  connection: 'connected' | 'disconnected'
  prompt: string
  startedAt: number
  finishedAt?: number
  running: number
  queued: number
  reused: number
  actions: LocalWorkflowAction[]
  /** The host accepts `finish`: stop admitting new agents and let the final step report. */
  canFinish?: true
  /** No new agents outside the final step: Finish now was pressed or Max agents was reached. */
  finishing?: true
  stages: {
    id: string
    label: string
    completed: number
    total?: number
    failed: number
    summary?: string
    markdown?: string
  }[]
  calls: LocalWorkflowCallView[]
  /** Program revision the run is pinned to. */
  revision?: number
  /** Current phase title reported by the program. */
  phase?: string
  /** Recent program log lines, oldest first (at most 50). */
  log?: string[]
  councilRun?: LocalWorkflowCouncilRun
  discoverRun?: LocalWorkflowDiscoverRun
  graphRun?: LocalWorkflowGraphRun
  /** Additive marker: older clients render the generic stage rail and report. */
  audit?: { version: 1; sourceCount: number; chunkCount: number }
  /** @deprecated legacy revision 1-4 shape; use councilRun. */
  council?: {
    reviews: LocalWorkflowCouncilReview[]
    ranking: LocalWorkflowCouncilRanking[]
  }
  findings?: {
    id: string
    label: string
    disposition: string
    markdown: string
    sources: LocalWorkflowSource[]
    verdicts: { label: string; verdict: string; markdown: string }[]
  }[]
  discoverCounts?: {
    found: number
    duplicates: number
    belowThreshold: number
    overLimit: number
    omittedByFinder: number
    assessed: number
    verdictsCompleted: number
    verdictsTotal: number
    survivors: number
    refuted: number
    notVerified: number
    unresolved: number
  }
  result?: LocalWorkflowResult
  usage?: {
    hostAttempts: number
    maxHostAttempts: number
    tokens: { kind: 'reported' | 'estimated'; input: number; output: number } | null
    limitation?: string
  }
  followUpLabel?: string
  /** Frozen synthesis route from the host; the renderer must verify it before a follow-up launch. */
  followUpSeat?: ResolvedLocalWorkflowSeat
  /** Where the run was placed at admission; absent on runs from before placement was a choice. */
  placement?: WorkflowPlacement
  /** Who asked an agent to start this run, and their words; absent when a person started it. */
  requestedBy?: string
  requestedById?: string
  request?: string
  savedOutput?: { filePath: string; sha256: string }
  outputError?: string
  /**
   * The host could not read this run's records: an earlier version wrote them, or they are
   * damaged. The view keeps only the question; `error` holds the host's reasons, for Details.
   */
  unreadable?: 'earlier-version' | 'damaged'
  error?: string
}
