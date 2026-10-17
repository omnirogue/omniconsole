import type { WorkflowDiscoverStats } from './workflow-discover-stats'
import { z } from 'zod'
import type { DiscoverDecisionTotals } from './discover-omnios-decisions'

/**
 * `omni workflow stats`: what the judging record says about which steps, judges, models and
 * rubrics win, how often JEV escalates, and what it costs. A report only: nothing reads it back
 * to change a seat, a rubric or a threshold, because tuning against a judge gets gamed.
 */
export const WORKFLOW_JUDGING_STATS_NOTE =
  "Wins are the judges' view of the answers, not real results."

export const workflowJudgingStatsRequestSchema = z
  .object({
    /** Only this template's lines. */
    template: z.string().trim().min(1).max(64).optional(),
    /** Only lines recorded at or after this time (milliseconds since the epoch). */
    since: z.number().int().nonnegative().optional()
  })
  .strict()

export type WorkflowJudgingStatsRequest = z.infer<typeof workflowJudgingStatsRequestSchema>

/** Anything the record does not say is unknown, never 0. */
export type Unknown = 'unknown'
export type Known<T> = T | Unknown

/** Tokens or time summed over the rounds that recorded them; `rounds` says how many did. */
export type WorkflowJudgingSum = { total: number; rounds: number }
export type WorkflowJudgingTokens = { input: number; output: number; rounds: number }

/** What a step was judged by: its frozen contract, else the digest of the rubric JEV saw. */
export type WorkflowJudgingDecision = { contract: string } | { rubricDigest: string } | Unknown

/** Who ranked a round: JEV alone, the model judges alone, or both. */
export type WorkflowJudgingJudges = 'jev' | 'models' | 'jev and models'

/** One row: a template's step, judged one way by one set of judges, over every recorded round. */
export type WorkflowJudgingGroup = {
  template: string
  stepId: string
  decision: WorkflowJudgingDecision
  judgedBy: WorkflowJudgingJudges
  rounds: number
  /** Rounds a new answer won, by the model family that wrote it. */
  wins: Record<string, number>
  /** Rounds Improve's best version held its place; never credited to its seat as a win. */
  defences: number
  jev: {
    /** JEV's ballot decided by itself: no model judge voted. */
    alone: number
    /** JEV was unsure and the model judges voted. */
    escalated: number
    /** JEV was asked and gave no ballot; unknown when a line does not say whether it was asked. */
    failed: Known<number>
    /** JEV's ballot counted although it said it was unsure. */
    countedWhileUnsure: number
  }
  /** Hard rounds only: models vote only when JEV is unsure, so this never covers easy rounds. */
  agreement: Known<{ rounds: number; topSame: number }>
  jevTokens: Known<WorkflowJudgingTokens>
  jevUsd: Known<number>
  modelJudgeCalls: number
  jevMs: Known<WorkflowJudgingSum>
  /** When the first and last recorded round settled. */
  first: number
  last: number
}

/** One seat: a model family, its model and the system prompt it wrote under. */
export type WorkflowJudgingSeat = {
  route: string
  model: Known<string>
  systemDigest: Known<string>
  /** Rounds one of its new answers competed in. */
  entered: number
  wins: number
  /** Rounds its earlier answer, as Improve's best version, held its place. */
  defences: number
}

/** One gate: a set-aside or shortlist screen, the one-answer route, or the final check. */
export type WorkflowJudgingGateRow = {
  template: string
  stepId: string
  gate: string
  contract: Known<string>
  count: number
  /** How often the gate decided each way, in the words the run uses. */
  decisions: Record<string, number>
  jevFailed: number
  /** Live JEV verify: items the reviewers left unverified that JEV confirmed, over every line. */
  jevConfirmed?: number
  /** Live JEV verify: items the reviewers left unverified that JEV set aside, over every line. */
  jevRefuted?: number
  jevTokens: Known<WorkflowJudgingTokens>
  jevUsd: Known<number>
  jevMs: Known<WorkflowJudgingSum>
}

/** What people picked on Discover's OmniOS pages (decisions.json): how often a finding is acted on. */
export type WorkflowDiscoverDecisions = DiscoverDecisionTotals

export type WorkflowJudgingStats = {
  note: typeof WORKFLOW_JUDGING_STATS_NOTE
  source: {
    file: string
    /** Lines read, lines that could not be read (a torn last line), and repeats skipped. */
    lines: number
    skipped: number
    duplicates: number
    /** Lines the template and since filters kept. */
    matched: number
    /** Older lines whose JEV method and tokens came from the run's own ballots file. */
    joined: number
  }
  tariff: { model: string; inputUsdPerMillion: number; outputUsdPerMillion: number }
  groups: WorkflowJudgingGroup[]
  seats: WorkflowJudgingSeat[]
  discover?: WorkflowDiscoverStats
  gates: WorkflowJudgingGateRow[]
  /** `omni workflow stats` adds it from this computer's Discover pages. */
  decisions?: WorkflowDiscoverDecisions
}
