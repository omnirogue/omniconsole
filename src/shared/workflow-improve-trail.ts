/**
 * The record of an Improve search, shared by the planner that builds it and the run view that
 * draws it: every round's versions, who judged them, what was kept, and why the search stopped.
 */

/** What an improver is asked to do in a round. */
export type WorkflowImproveRole = 'first' | 'improve' | 'explore' | 'divergent'

export type WorkflowImproveCandidate = {
  label: string
  name: string
  seatId: string
  /** `best` is the version that held the lead going into the round. */
  role: WorkflowImproveRole | 'best'
  place?: number
  votes?: number
  /** Became the best version in this round. */
  accepted?: true
  /** Several versions to build on: the one this version built on (round 0 is "No change"). */
  parent?: { round: number; name: string }
  /** Predictions on: what the version said its test would show, and whether that held. */
  prediction?: WorkflowImprovePrediction
  /** Its change repeats this earlier version's, diff noise aside: that check result was reused. */
  duplicateOf?: { round: number; name: string }
  /** The objective check on this version: passed, the score it reported, practice cases passed. */
  check?: {
    passed: boolean
    score?: number
    unavailable?: true
    cases?: { passed: number; total: number }
    /** A change to the code that adds a call ending the process early (flagged, not refused). */
    exits?: string[]
  }
}

/** How a prediction compares a score with its number. */
export type WorkflowPredictionOp = '>=' | '<=' | '>' | '<'

/**
 * A version's prediction, judged against its measured test result. `held` and `untested` (the
 * test could not run) are kept; `missed` and `missing` (no prediction line) are killed.
 */
export type WorkflowImprovePrediction = {
  verdict: 'held' | 'missed' | 'missing' | 'untested'
  predicted?: { outcome: 'pass' | 'fail' } | { op: WorkflowPredictionOp; score: number }
  measured?: { passed: boolean; score?: number }
}

export type WorkflowImproveRound = {
  round: number
  mode: 'first' | 'improve' | 'divergent'
  candidates: WorkflowImproveCandidate[]
  /** What decided the round: the objective check, and whose ballots. */
  judgedBy: ('check' | 'jev' | 'models')[]
  jevUnsure?: true
  /**
   * JEV was unsure and still counted with the model judges (they could not compare every pair,
   * or both always vote). Without it, an unsure JEV stood aside and the models decided.
   */
  jevCounted?: true
  /** When JEV and the model judges both ranked: whether they put the same version first. */
  agreed?: boolean
  result: 'pending' | 'first' | 'new-best' | 'kept' | 'unjudged' | 'failed'
  reason?: string
  /** Rules 2: a new best only the judges chose; the check measured no gain, so patience ran on. */
  noGain?: true
  /** After a round without gain, the improvers worked on frontier models (repeat.frontier). */
  escalated?: true
}

export type WorkflowImproveTrail = {
  rounds: WorkflowImproveRound[]
  /** Round 0 is "No change": nothing beat the code as it is. */
  best?: { round: number; name: string; seatId: string }
  /** Rounds in a row without an accepted improvement, and how many end the search. */
  stale: number
  patience: number
  stop?: 'undecided' | 'plateau' | 'max-rounds' | 'verified' | 'passing-kept' | 'failed'
  /** Rules 2 with a check: only a better check result counts as progress. */
  measured?: true
  /** The final test kept back; absent without one, or before the search stops. */
  final?: WorkflowImproveFinal
}

/** One side of the final test: cases passed (or 1 for a pass without cases) and the mean score. */
export type WorkflowImproveFinalSide = { passed: number; score?: number }

export type WorkflowImproveFinal = {
  /** Absent while it runs; `same` when the winner is what the search started from. */
  verdict?: 'held' | 'tied' | 'worse' | 'unavailable' | 'same'
  /** Kept-back cases; 0 means a kept-back command run once. */
  cases: number
  /** What the winner is compared with: your code as it is, or round 1's best version. */
  start: 'unchanged' | 'round-1'
  best?: WorkflowImproveFinalSide
  started?: WorkflowImproveFinalSide
}

export type WorkflowLoopView = {
  round: number
  maxRounds: number
  status:
    | 'running'
    | 'approved'
    | 'not-approved'
    | 'dry'
    | 'low-yield'
    | 'max-rounds'
    | 'undecided'
    | 'plateau'
    | 'verified'
    | 'failed'
  improve?: WorkflowImproveTrail
}
