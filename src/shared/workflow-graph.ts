import { mayIssueVerdict } from './model-lineage'
import type { LocalWorkflowRoute } from './local-workflow-seats'

/**
 * The workflow model (docs/workflows/WORKFLOW-CORE-2026-09-22.md): a small acyclic graph of steps.
 * Four step kinds say what the agents in a step do and how their outputs combine; two modifiers
 * (for each, repeat) say how often a step runs. Parallel and sequential are not node types: a step
 * with N agents runs them at once, steps that do not depend on each other run at once, and an
 * input edge is a sequence.
 *
 * The editor, the natural-language compiler and the host all use `normalizeWorkflowSpec` and
 * `validateWorkflowSpec`, so a graph the editor accepts is exactly a graph the host admits.
 */
export type WorkflowStepKind = 'do' | 'review' | 'rank' | 'synthesize'
export type WorkflowRoute = LocalWorkflowRoute
export const WORKFLOW_ROUTES: readonly WorkflowRoute[] = [
  'claude',
  'codex',
  'grok',
  'gemini',
  'openrouter',
  'ollama'
]

export type WorkflowAgentSpec = {
  route: WorkflowRoute
  /** A catalog model id; absent means the team's model for this route. */
  model?: string
  /** A perspective this agent takes, e.g. "security" or "skeptic". */
  angle?: string
  /**
   * This seat's own system prompt: who it is and how it works. Seats of one model with different
   * system prompts compete like different models, and the judging record shows which wins.
   */
  system?: string
}

/**
 * JEV as a judge on a Rank step: one more ballot, from rubric scores or pairwise choices (`auto`
 * picks head to head for a few answers, rubric scores for many). With `only`, JEV ranks alone
 * and the step's agents judge only when JEV is unavailable or unsure.
 */
export type WorkflowJevJudge = { method: 'auto' | 'rubric' | 'pairwise'; only?: boolean }

export type WorkflowStep = {
  /** Slug, unique in the workflow. */
  id: string
  kind: WorkflowStepKind
  title: string
  /** What this step's agents are asked to do. Empty means the kind's default. */
  instruction: string
  agents: WorkflowAgentSpec[]
  inputs: string[]
  /**
   * Run this step once per item of an input step's list. `order: 'impact'` (review only): when
   * there are more items than the limit, one frontier call rates each item's impact and the most
   * important are checked first (measured: JEV order left 40 of 73 high-impact findings unchecked,
   * a frontier triage 2).
   */
  forEach?: {
    step: string
    limit: number
    screen?: WorkflowScreen
    order?: 'impact'
    /** With `order: 'impact'`: the triage also merges results that repeat an earlier one's root cause. */
    merge?: 'root-cause'
  }
  /** Do only: a list for a later for-each; `evidence` adds quotes the app checks before review. */
  list?: { maxItems: number; evidence?: true }
  /** Rank only: JEV judges too (or alone). */
  jev?: WorkflowJevJudge
  /**
   * Review for-each only: one reviewer checks each item first; the others join only when it does
   * not pass or the item is critical, for at most `max` items a round. With `standIn`, a first
   * review that gave no answer is made again by an agent on another provider, for at most `max`
   * items a round too.
   */
  escalate?: { max: number; crossFamily?: true; standIn?: true }
  /** Review for-each only: JEV's yes/no on every item, recorded beside the run (graph-jev-verify.ts). */
  jevVerify?: WorkflowJevVerify
  /**
   * Rank only (Decide's comparison, graph-compare.ts): rank its for-each input's answers one line
   * of `rubricFrom`'s rubric at a time. JEV judges each line in both orders; the agents rank a line
   * only when JEV is unsure or cannot. The overall order is the mean place over the lines.
   */
  byCriterion?: { rubricFrom: string }
  /** Do only: run only when the top two of this Rank step are close (Decide's crux). */
  whenClose?: string
  /** Synthesize only: the write-up also ranks the results of the review it reads (why, next step). */
  rankItems?: true
  /** New ranked reports also estimate effort and risk; absent in saved older specs. */
  rankEstimates?: true
  /** Synthesize only (Investigate): ends in a claims table the app holds to the fact-check it reads. */
  claimTable?: true
  /** Do only: pages the app reads once before the run's first reader; only its agents see them. */
  web?: { urls: string[] }
}

/**
 * Review for-each only: JEV scores every item before any reviewer runs. Items it scores below
 * WORKFLOW_SCREEN_SET_ASIDE are set aside unchecked; the rest go to the reviewers best first.
 * The rubric is written here or taken from the `## Rubric` section of an input step's answer.
 */
export type WorkflowScreen = {
  rubric?: string
  rubricFrom?: string
  /**
   * Do for-each only (Decide's narrowing, graph-shortlist.ts): drop the items JEV scores as
   * breaking the rubric source's hard limits, then keep a varied shortlist of at most `limit`:
   * the best overall, each rubric line's leader, and one wildcard.
   */
  shortlist?: true
}

/**
 * JEV asks one yes/no per item ("is this a real, in-scope defect?") over the cited code. `shadow`
 * only records the probability on each target and changes nothing the run decides. `live` also
 * sets aside (refutes, marked as JEV's) what the reviewers left unverified at p <= `rejectAt`, and
 * confirms at p >= `confirmAt`; with neither set it sets aside at JEV_VERIFY_REJECT_AT and never
 * confirms. It never changes a reviewer's verdict. `unknown` keeps a mode this build does not
 * know, so validation names it instead of dropping it.
 */
export type WorkflowJevVerify =
  | { mode: 'shadow' }
  | { mode: 'live'; confirmAt?: number; rejectAt?: number }
  | { mode: 'unknown' }

/** JEV's 0–4 scale: below 1 an item "fails the task" — measured to catch non-findings only. */
export const WORKFLOW_SCREEN_SET_ASIDE = 1

/** How often an Improve loop tries substantially different approaches instead of refining. */
export type WorkflowExplore = 'low' | 'normal' | 'high'

/**
 * An objective check an Improve loop runs on every version: a command the person typed, run in
 * the workspace without a shell. Exit 0 passes; a last output line `SCORE: <number>` ranks
 * (higher is better). Passing and a higher score beat any judge's opinion.
 */
export type WorkflowCheck = {
  command: string
  /** Stop as soon as the best version passes (only when the check reports no score). */
  stopWhenPassing?: boolean
  /** Improve rules 2: the command runs once per line, the line replacing `{case}`. */
  cases?: string[]
  /** Improve rules 2: each run's time limit; absent, WORKFLOW_CHECK_DEFAULT_SECONDS. */
  timeoutSeconds?: number
  /**
   * Improve rules 2: `patch` makes each version a change to this Git repository (a unified
   * diff), applied and tested in a private copy of it; absent, a version is text.
   */
  apply?: 'patch'
  /** A change to the code only: the person's command, run once in each private copy. */
  prepare?: string
  /** A change to the code only: the person's paths (globs) no version may change. */
  protect?: string[]
  /** Improve rules 2: the person's final test, kept back from every prompt and run once at the end. */
  sealed?: WorkflowSealedCheck
  /**
   * Improve rules 2, set only by the person: each version ends with `PREDICTION: PASS | FAIL |
   * SCORE >= n` (also <=, >, <); one whose prediction misses, or that has none, is dropped.
   */
  predict?: true
}

/** Without its own command the test command runs; without cases it runs once. */
export type WorkflowSealedCheck = { command?: string; cases?: string[] }

/** Improve's built-in instructions a person may reword: one per improver role, and the rules. */
export const WORKFLOW_IMPROVE_PROMPT_KEYS = [
  'first',
  'improve',
  'explore',
  'divergent',
  'rules'
] as const
export type WorkflowImprovePromptKey = (typeof WORKFLOW_IMPROVE_PROMPT_KEYS)[number]
/** Only the person's own wording; a missing key uses the built-in one. */
export type WorkflowImprovePrompts = Partial<Record<WorkflowImprovePromptKey, string>>

export type WorkflowRepeat = {
  /** The Do step that runs again each round. */
  do: string
  /**
   * The step that decides: a Review (until approved, until nothing new) or, until it stops
   * improving, a Rank that compares each round's challengers with the best version so far.
   */
  review: string
  until: 'approved' | 'nothing-new' | 'plateau'
  maxRounds: number
  /** Nothing-new: skip later rounds below this confirmed round-1 yield; absent means off. */
  minConfirmedForRound2?: number
  /** Plateau only: stop after this many rounds in a row without an accepted improvement. */
  patience?: number
  /** Plateau only: how much of each round explores different approaches. */
  explore?: WorkflowExplore
  /** Plateau only: an objective check every version must pass (tests, a benchmark, a checker). */
  check?: WorkflowCheck
  /** Plateau only: the person's wording for Improve's built-in instructions. */
  prompts?: WorkflowImprovePrompts
  /**
   * Improve rules 2: how many versions improvers build on (2 to WORKFLOW_MAX_POPULATION): the
   * best, plus versions that pass a practice case the best fails. Absent means only the best.
   */
  population?: number
  /**
   * Plateau only: the frontier model each improver moves to, by family, once a round brings no
   * gain; one such round always runs before the search stops. An improver whose family has none
   * keeps its own model. Absent, improvers never change model.
   */
  frontier?: WorkflowAgentSpec[]
}

/** Which starting point a workflow came from; only drives icons and names. */
export type WorkflowTemplateId =
  | 'council'
  | 'discover'
  | 'quick-discover'
  // Kept though no template builds it: a saved spec naming it normalizes the same and is refused.
  | 'build-review'
  | 'best-of-n'
  | 'improve'
  | 'find'
  | 'decide'
  | 'investigate'
  | 'custom'

/**
 * Find the best: many options (the models come up with them, or the person gives a list), or a
 * few complete versions, one from each model; JEV scores every one, and the best meet head to head.
 */
export type WorkflowFindItem = string | { title: string; detail?: string; url?: string }

export type FindImportSkip = { line: number; reason: string }
/** What actually happened to a person's list: read, kept, dropped (with why) and merged. Set once
 * and never recomputed afterward, so re-normalizing an already-imported list never rewrites it. */
export type FindImportReceipt = {
  read: number
  imported: number
  skipped: FindImportSkip[]
  merged: number
}

export type WorkflowFind = {
  /** How many options (or versions) to come up with; unused when the person gives their own. */
  count: number
  /** Each model writes one complete version instead of listing short options (Best of N). */
  versions?: true
  /** Complete versions only: a person's objective check every version runs; it outranks judges. */
  check?: WorkflowCheck
  /** The person's own options, one each; when set, nothing is generated. Titles only: an older
   * build that has never heard of detail/url still reads every option correctly. */
  items?: string[]
  /** detail/url for the item at the same index, when Scan or a link column named one. */
  itemDetails?: { detail?: string; url?: string }[]
  /** Entries merged into another because their title, detail and url all matched (normalize time). */
  importMerged?: number
  /** The full, immutable record of what happened when this list was imported. */
  importReceipt?: FindImportReceipt
  /**
   * Search GitHub for repositories and add every one it finds to the pool. Only the person ever
   * sets this: the spec compiler strips whatever a model wrote (workflow-graph-compile.ts).
   */
  harvest?: { query: string; max: number }
  /** How many meet in the final, and how many each line of the rubric brings back. */
  top: number
  /** How many of the best to bring back; absent on runs from before, which bring back `top`. */
  keep?: number
}

export type WorkflowSpec = {
  version: 1
  title: string
  template: WorkflowTemplateId
  steps: WorkflowStep[]
  repeat?: WorkflowRepeat
  find?: WorkflowFind
  /**
   * Opt-in, frozen Council comparison after the chair settles. `skeptic` (Decide): one reviewer
   * from the rank step's judges checks the chair keeps every hard limit in that step's answer.
   */
  finalCheck?: { rank: string; chair: string; skeptic?: string }
  /**
   * Opt-in route (workflow-one-answer.ts): JEV first asks whether the question has one right
   * answer. Only when it is sure, `step` (one agent, nothing reads it) answers alone and the run
   * ends there; otherwise, or when JEV cannot answer, the rest of the workflow runs.
   */
  oneAnswer?: { step: string }
}

export const WORKFLOW_MAX_STEPS = 12
export const WORKFLOW_MAX_AGENTS_PER_STEP = 8
export const WORKFLOW_MAX_RANK_CANDIDATES = 8
export const WORKFLOW_MAX_ROUNDS = 5
/** Improving is cheap per round and stops itself on a plateau, so it may run longer. */
export const WORKFLOW_MAX_IMPROVE_ROUNDS = 10
export const WORKFLOW_DEFAULT_IMPROVE_ROUNDS = 6
export const WORKFLOW_MAX_PATIENCE = 4
/** Improve: the most versions kept to build on each round (the best and three others). */
export const WORKFLOW_MAX_POPULATION = 4
export const WORKFLOW_DEFAULT_PATIENCE = 2
export const WORKFLOW_MAX_LIST_ITEMS = 20
/** Find the best: options come up in batches of one list call each. */
export const WORKFLOW_FIND_DEFAULT_COUNT = 100
export const WORKFLOW_FIND_MAX_COUNT = 160
export const WORKFLOW_FIND_MAX_ITEMS = 2000
export const WORKFLOW_FIND_MAX_ITEM_CHARS = 1_000
export const WORKFLOW_FIND_DEFAULT_TOP = 5
export const WORKFLOW_FIND_DEFAULT_KEEP = 10
/** Complete versions: one model call each, so no more than a step has agents. */
export const WORKFLOW_FIND_DEFAULT_VERSIONS = 4
export const WORKFLOW_FIND_MAX_KEEP = 100
/** Search GitHub: what the person may type, and how many repositories one search may bring back. */
export const WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS = 256
export const WORKFLOW_FIND_HARVEST_MAX = 100
export const WORKFLOW_FIND_HARVEST_DEFAULT = 30
export const WORKFLOW_DEFAULT_LIST_ITEMS = 8
export const WORKFLOW_MAX_FOR_EACH = 24
/** A comparison by criterion judges at most this many rubric lines. */
export const WORKFLOW_MAX_CRITERIA = 6
/** Two overall places at most this far apart (1 = a whole place) are close. */
export const WORKFLOW_CLOSE_GAP = 0.5
/** One reviewer per item first leaves room to check more items: the escalation cap bounds the rest. */
export const WORKFLOW_MAX_FOR_EACH_ESCALATED = 48
export const WORKFLOW_DEFAULT_FOR_EACH = 12
/** The most agent calls one run may plan; the host refuses larger graphs. */
export const WORKFLOW_MAX_CALLS = 200
export const WORKFLOW_MAX_INSTRUCTION_CHARS = 4_000
export const WORKFLOW_MAX_SYSTEM_CHARS = 4_000
export const WORKFLOW_MAX_CHECK_CHARS = 1_000
export const WORKFLOW_CHECK_MAX_CASES = 20
export const WORKFLOW_CHECK_MAX_CASE_CHARS = 1_000
export const WORKFLOW_CHECK_DEFAULT_SECONDS = 180
export const WORKFLOW_CHECK_MIN_SECONDS = 5
export const WORKFLOW_CHECK_MAX_SECONDS = 1_800
/** All of one version's practice cases together; a case that no longer fits is not run. */
export const WORKFLOW_CHECK_VERSION_BUDGET_SECONDS = 1_800
export const WORKFLOW_CHECK_MAX_PROTECT = 40
export const WORKFLOW_CHECK_MAX_PROTECT_CHARS = 200
/** Getting a private copy ready (an install) may take longer than one test. */
export const WORKFLOW_CHECK_PREPARE_SECONDS = 900
export const WORKFLOW_MAX_TITLE_CHARS = 80
/** A step id: a short lowercase slug. */
export const WORKFLOW_STEP_ID = /^[a-z][a-z0-9-]{0,31}$/

export const WORKFLOW_KIND_LABELS: Record<WorkflowStepKind, string> = {
  do: 'Do',
  review: 'Review',
  rank: 'Rank',
  synthesize: 'Synthesize'
}

/** Kinds whose agents decide whether work passed or which work is best (estate verdict rule). */
export function workflowKindJudges(kind: WorkflowStepKind): boolean {
  return kind !== 'do'
}

/** Only a Do step's own agents ever read page text; every other step sees what they wrote. */
export function workflowStepReadsWeb(step: WorkflowStep): boolean {
  return step.kind === 'do' && !!step.web?.urls.length
}

/** Gemini may do work but never issues a verdict, a ranking or the final synthesis. */
export function workflowRouteMayJudge(route: WorkflowRoute, model?: string): boolean {
  return mayIssueVerdict(route, model)
}

export type WorkflowProblem = {
  /** The step the problem is about; absent for problems with the whole graph. */
  stepId?: string
  message: string
}

export type WorkflowValidation = {
  problems: WorkflowProblem[]
  warnings: WorkflowProblem[]
}
