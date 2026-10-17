import type { DecisionContractCheck } from './decision-contracts/decision-contract-check'
import type { CouncilFinalCheck } from './workflow-council-final-check'
import type { WorkflowSpec } from './workflow-graph'
import type { WorkflowLoopView } from './workflow-improve-trail'
import type { WorkflowFindTrail } from './workflow-find-trail'
import type { WorkflowOneAnswerRoute } from './workflow-one-answer'
import type { WorkflowReportRank } from './workflow-report-ranking'
import type { WorkflowWebTrail } from './workflow-web-trail'
import type { WorkflowClaimRow } from './workflow-claim-table'
import type { WorkflowWebCheck } from './workflow-graph-web'
import type { LocalWorkflowSeatView } from './local-workflow-view'

export type LocalWorkflowGraphState =
  | 'waiting'
  | 'running'
  | 'done'
  | 'gaps'
  | 'failed'
  | 'not-run'
  | 'empty'
export type LocalWorkflowGraphVerdict = 'pass' | 'fail' | 'unsure'
/** The app's check of a finder's quote against the file (graph-evidence-check.ts). */
export type LocalWorkflowEvidenceStatus =
  | 'found'
  | 'moved'
  | 'missing'
  | 'unreadable'
  | 'not-code'
  | 'unquoted'
export type LocalWorkflowGraphItem = {
  key: string
  title: string
  detail: string
  location: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'none'
  repeats: number
  round?: number
  sourceCallId?: string
  alsoFrom?: string[]
  /** Keys absorbed into this target; earlier verdicts for those keys are superseded. */
  alsoMerged?: string[]
  /** Reports merged into this one that were not exact copies, as they were written. */
  alsoReported?: Pick<LocalWorkflowGraphItem, 'title' | 'detail' | 'location' | 'severity'>[]
  /** The severity it was first reported with, when a later report raised it. */
  reportedSeverity?: LocalWorkflowGraphItem['severity']
  parentKey?: string
  /** JEV's 0–4 score when a screen ranked the items for review. */
  jev?: { score: number; reason?: string }
  /** A frontier triage's 1–5 impact rating, when it chose which items were checked first. */
  impact?: { score: number; why: string }
  /** Discover with evidence: where the app found the finder's quote, or why it could not. */
  evidence?: {
    status: LocalWorkflowEvidenceStatus
    line?: number
    preVerify?: LocalWorkflowPreVerify
  }
}

/** Evidence rules 2: the problems the app found in a result's citations and absence searches. */
export type LocalWorkflowPreVerify = {
  flags: string[]
  /** Why no reviewer saw it: no file it cites exists. */
  dropped?: string
}
/** One run of a step: one round, or the only round outside a repeat. */
export type LocalWorkflowGraphRound = {
  finalCheck?: CouncilFinalCheck
  round: number
  state: LocalWorkflowGraphState
  reason?: string
  /** The step's agent calls this round; the call view with the same id carries text and live state. */
  calls: {
    callId: string
    agentIndex: number
    itemKey?: string
    status: 'waiting' | 'done' | 'failed'
    /** JEV's ballot: no agent, terminal or log behind it. */
    jev?: true
    verdict?: LocalWorkflowGraphVerdict
    items?: number
  }[]
  /** Anonymous labels the agents' answers carried ("Response B"), for ballots and reviews. */
  labels?: { callId: string; label: string }[]
  items?: LocalWorkflowGraphItem[]
  targets?: (LocalWorkflowGraphItem & {
    tally: 'confirmed' | 'refuted' | 'unverified'
    votes: (LocalWorkflowGraphVerdict | null)[]
    /** Over the for-each limit: no reviewer saw it. */
    unchecked?: boolean
    /** Unchecked because JEV set it aside as a non-finding. */
    screened?: boolean
    /** JEV set it aside, then a later report it never saw put it back to unverified. */
    resurfaced?: true
    /** Resurfaced after live JEV verify set it aside at this probability. */
    setAsideAt?: number
    /** A reviewer from a family other than every finder's passed it. */
    crossChecked?: boolean
    /** Only reviewers from its finders' families passed it: unverified. */
    sameFamilyOnly?: boolean
    /** A run that reads pages: the app's checks of its quotes; unbacked means none was found. */
    webChecks?: WorkflowWebCheck[]
    webUnbacked?: true
    /** JEV verify: its probability the item is real; only live mode decides anything by it. */
    jevVerify?: number
    /** Live JEV verify confirmed it after the reviewers left it unverified. */
    confirmedBy?: 'jev'
    /** Live JEV verify set it aside (refuted) after the reviewers left it unverified. */
    refutedBy?: 'jev'
  })[]
  approved?: boolean
  standings?: { label: string; name: string; averageRank: number; votes: number; place: number }[]
  /** A comparison by criterion's overall round: each rubric line's leaders and who judged it. */
  criteria?: {
    criterion: string
    leaders: string[]
    judgedBy: ('jev' | 'models')[]
    /** Why the line was not settled; it is left out of the overall order. */
    unsettled?: string
  }[]
  setAside?: number
  notes: string[]
}
/** A finding a review step confirmed, listed as soon as its reviews are all in. */
export type LocalWorkflowVerifiedFinding = Pick<
  LocalWorkflowGraphItem,
  'key' | 'title' | 'detail' | 'location' | 'severity'
> & { stepId: string; round: number }
/** Workflow graph runs: the frozen graph, and every step's state derived from its call records. */
export type LocalWorkflowGraphRun = {
  spec: WorkflowSpec
  /** Dependency level of each step: steps in one column can run at once. */
  levels: Record<string, number>
  steps: {
    id: string
    state: LocalWorkflowGraphState
    reason?: string
    agents: (LocalWorkflowSeatView & { angle?: string })[]
    rounds: LocalWorkflowGraphRound[]
  }[]
  loop?: WorkflowLoopView
  /** Find the best: where the run stands, its shortlists and its winner. */
  find?: WorkflowFindTrail
  /** One-answer routing: what JEV decided about the question. */
  route?: WorkflowOneAnswerRoute
  /** The report's value order of the reviewed results, with why and the next step. */
  ranking?: WorkflowReportRank[]
  /** A run that reads pages: the claims table's rows, each with the app's own quote checks. */
  claims?: WorkflowClaimRow[]
  /** Runs that review items one by one: every finding confirmed so far, settled rounds first. */
  verified?: LocalWorkflowVerifiedFinding[]
  /** A run that reads pages: each page's id, address and state; never its text or title. */
  web?: WorkflowWebTrail
  /** How far each JEV decision's rule has been checked against known answers; absent on unreadable runs. */
  contracts?: DecisionContractCheck[]
  gaps: string[]
  /**
   * The run lost agent calls it could not move to another account or model family: its result
   * stands on less than it planned, whatever its state says. Named in `gaps` too.
   */
  degraded?: { lostCalls: number; steps: string[] }
  notes: string[]
}
