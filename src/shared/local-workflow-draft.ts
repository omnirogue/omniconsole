import type { WorkflowRunsOn } from './local-workflow-placement'
import type { LocalWorkflowSeatChoice } from './local-workflow-seats'
import type { WorkflowSpec } from './workflow-graph'
import type { WorkflowContextSource } from './workflow-context-sources'
import type { LocalWorkflowAuditDraft } from './workflow-audit-draft'

export type LocalWorkflowPreset = 'council' | 'discover'
export type LocalWorkflowCapability = 'frozen-analysis' | 'working-agent'
export type LocalWorkflowScopeOption = { id: string; label: string; unavailableReason?: string }
/**
 * auto: the workspace plus what the request names; sources: only the chosen files, folders and
 * repos (the workspace when ticked); frozen: attached text only. workspace-read is what a Start
 * sends and what older drafts saved: it reads like auto with nothing else chosen.
 */
export type LocalWorkflowAccess = 'auto' | 'sources' | 'workspace-read' | 'frozen'
export type DiscoverDepth = 'quick' | 'thorough' | 'exhaustive'
export const DISCOVER_LENS_IDS = [
  'correctness',
  'reliability',
  'security',
  'performance',
  'user-path',
  'data-integrity'
] as const
export type DiscoverLensId = (typeof DISCOVER_LENS_IDS)[number]
export const DISCOVER_DEFAULT_MAX_AGENTS = 160
export const DISCOVER_MAX_AGENTS_CEILING = 400
/**
 * The smallest Discover agent budget that can search at all: the scout, one finder job with room
 * for three votes on a fresh finding, and the call Rank keeps in reserve. Below it the revision 7
 * planner skips every finder job.
 */
export const DISCOVER_MIN_AGENTS = 6
/** Finders in one revision 7 run. Verifiers need no role: every non-Google seat may verify. */
export const DISCOVER_MAX_FINDERS = 4
/** Votes each fresh revision 7 finding gets: correctness, reachability and reproduction. */
export const DISCOVER_VOTES_PER_FINDING = 3
/** The most findings one revision 7 finder job may report (its schema's bound). */
export const DISCOVER_MAX_FINDINGS_PER_JOB = 8
/**
 * The most areas a revision 7 scout returns (its schema's bound). It returns at least two; without
 * a map the run searches the whole focus as one area.
 */
export const DISCOVER_MAX_AREAS = 8
/** Rounds per depth, and how many dry rounds in a row stop the loop. */
export const DISCOVER_DEPTH_ROUNDS: Record<DiscoverDepth, { maxRounds: number; dryLimit: number }> =
  {
    quick: { maxRounds: 1, dryLimit: 1 },
    thorough: { maxRounds: 3, dryLimit: 1 },
    exhaustive: { maxRounds: 5, dryLimit: 2 }
  }
/** Distinct models in one revision 7 lineup: finders, verifiers and the ranker together. */
export const DISCOVER_MAX_SEATS = 6
export const COUNCIL_MIN_MEMBERS = 2
export const COUNCIL_MAX_MEMBERS = 6

/**
 * A workflow graph (docs/workflows/WORKFLOW-CORE-2026-09-22.md) and the team it runs on: the
 * account, model and effort each model family uses, one choice per family (`id` = the family).
 * The host normalizes and validates the spec again and resolves every agent to a team seat.
 */
export type LocalWorkflowGraphDraft = {
  spec: WorkflowSpec
  team: LocalWorkflowSeatChoice[]
  /** Most agent calls the run may make, the final step's included; absent, the spec's bound. */
  maxAgents?: number
}

/** A renderer request; the host resolves accounts, scope and limits again before admission. */
export type LocalWorkflowDraft = {
  prompt: string
  audit?: LocalWorkflowAuditDraft
  /** Present on every draft started from the workflow graph editor or a graph template. */
  graph?: LocalWorkflowGraphDraft
  /**
   * frozen-analysis (default) runs the current read-only programs; working-agent runs the writable
   * Council revision 5 / Discover revision 6 in isolated orchestration worktrees.
   */
  capability?: LocalWorkflowCapability
  outputFileName?: string
  /**
   * Distinct seats (seat-1..seat-N). Legacy drafts: exactly three, Discover's first is the finder.
   * Current drafts name roles explicitly in `council.memberIds` / `discover.finderIds`.
   */
  seats: LocalWorkflowSeatChoice[]
  /** Council chairman or Discover ranker. */
  synthesizerId: string
  /** Optional attached files, frozen into the prompt as numbered text. */
  scopeIds: string[]
  /**
   * Absent on drafts saved before access was a choice. Admission withholds the workspace only for
   * 'frozen', so a missing field reads it; legacy runs replay from their own frozen snapshots.
   */
  access?: LocalWorkflowAccess
  /** Files, folders and GitHub repositories agents read too; copied into one private folder. */
  contextSources?: WorkflowContextSource[]
  /** Whether that folder holds the current workspace; absent: yes, except for access 'sources'. */
  includeWorkspace?: boolean
  /**
   * Where the run executes. Absent on drafts saved by older builds and on messages from older
   * clients: the host reads that as 'fleet' for a new Start and never rewrites a frozen snapshot.
   */
  runsOn?: WorkflowRunsOn
  /**
   * "Run on: <host>": a fleet host by name (docs/reference/workflow-fleet-placement.md). A host
   * from before named hosts rejects the field (its Start schema is strict) instead of choosing.
   */
  runsOnHost?: string
  /** The execution host id picked with it (`ssh:<target-id>` or `local`), recorded with the run. */
  runsOnHostId?: string
  /** A person's reason to run on a named host above the load bound; an agent never sends it. */
  forceHost?: string
  /** Who asked an agent to start this run, and their words; frozen with the run. */
  requestedBy?: string
  requestedById?: string
  request?: string
  /** Start without the cross-run known list (earlier runs' findings on the same target). */
  skipEarlierRuns?: true
  focusFinding?: string
  /**
   * The approved OmniSI budget root this run spends (agent budget controls). Required while this
   * computer enforces budgets; a host from before budgets rejects the field (strict Start schema).
   */
  budgetRootId?: string
  /** Council revision 6: members answer; non-Google members also rank. */
  council?: { memberIds: string[] }
  concurrency: number
  callLimit: number
  attemptLimit: number
  maxHostAttempts: number
  discover: {
    dimensions: string[]
    lenses: string[]
    minimumSeverity: 'low' | 'medium' | 'high' | 'critical'
    maxCandidates: number
    /** Discover revision 7. */
    finderIds?: string[]
    lensIds?: DiscoverLensId[]
    depth?: DiscoverDepth
    /** Workspace-relative folders or files to focus on; empty means the whole workspace. */
    focus?: string[]
    /** Upper bound on agent calls for the run. */
    maxAgents?: number
  }
}

/** How many of `jobCount` finder jobs fit in `available` calls, and the findings they may share. */
function discoverRoundShape(available: number, jobCount: number) {
  const jobs = Math.max(
    0,
    Math.min(jobCount, Math.floor(available / (1 + DISCOVER_VOTES_PER_FINDING)))
  )
  const findings = Math.min(
    jobs * DISCOVER_MAX_FINDINGS_PER_JOB,
    Math.floor((available - jobs) / DISCOVER_VOTES_PER_FINDING)
  )
  return { jobs, findings: jobs ? findings : 0 }
}

/** Breadth first: every job runs while each can still report one finding; the rest raise limits. */
function discoverFindingLimits(shape: { jobs: number; findings: number }): number[] {
  const { jobs, findings } = shape
  return Array.from(
    { length: jobs },
    (_, index) => Math.floor(findings / jobs) + (index < findings % jobs ? 1 : 0)
  )
}

/**
 * Whether a round keeps one call for its repeat check: only a round whose finders may report two
 * findings or more can report one defect twice.
 */
export function discoverRoundKeepsRepeatCheck(findingLimits: readonly number[]): boolean {
  return findingLimits.reduce((total, limit) => total + limit, 0) >= 2
}

/**
 * The revision 7 planner's rule for one round: how many of its `jobCount` finder jobs fit in
 * `available` calls, how many findings each keeps votes for, so that every finding the round
 * admits still gets all its votes, and whether one call is kept for the repeat check that groups
 * the round's findings by root cause before any is verified. A job may report more than its share;
 * the round never admits more fresh findings than the shares add up to. The check never costs a
 * finder job: when it would, the round runs without one and every finding it reports is verified.
 */
export function discoverRoundBudget(
  available: number,
  jobCount: number
): { findingLimits: number[]; repeatCheck: 0 | 1 } {
  const plain = discoverFindingLimits(discoverRoundShape(available, jobCount))
  if (!discoverRoundKeepsRepeatCheck(plain)) {
    return { findingLimits: plain, repeatCheck: 0 }
  }
  const checked = discoverFindingLimits(discoverRoundShape(available - 1, jobCount))
  return checked.length < plain.length || !discoverRoundKeepsRepeatCheck(checked)
    ? { findingLimits: plain, repeatCheck: 0 }
    : { findingLimits: checked, repeatCheck: 1 }
}

/**
 * Walks every way a run over `areas` can go by the planner's own rules: each round starts what
 * fits, its finders report any number of new findings up to the round's limit, and the loop stops
 * on the depth's dry rounds, its last round, or a budget too small for one more job. Returns the
 * fewest and the most calls any such run makes, counting Rank once something was found.
 */
function discoverRunRange(
  areas: number,
  lensCount: number,
  depth: DiscoverDepth,
  maxAgents: number
): { low: number; high: number } {
  const { maxRounds, dryLimit } = DISCOVER_DEPTH_ROUNDS[depth]
  const range = { low: Number.POSITIVE_INFINITY, high: 0 }
  const settle = (free: number, found: boolean) => {
    // Every call but the free ones and the one kept for Rank was made; Rank runs on a finding.
    const used = maxAgents - 1 - free + (found ? 1 : 0)
    range.low = Math.min(range.low, used)
    range.high = Math.max(range.high, used)
  }
  type State = { free: number; dry: number; found: boolean }
  // The scout is planned first and one call stays reserved for Rank.
  let states: State[] = [{ free: maxAgents - 2, dry: 0, found: false }]
  for (let round = 1; states.length; round++) {
    const next = new Map<number, State>()
    for (const state of states) {
      const { findingLimits, repeatCheck } = discoverRoundBudget(state.free, areas * lensCount)
      const jobs = findingLimits.length
      if (!jobs) {
        settle(state.free, state.found)
        continue
      }
      const findings = findingLimits.reduce((total, limit) => total + limit, 0)
      for (let fresh = 0; fresh <= findings; fresh++) {
        // The check runs only when two new findings share a file, and may merge them down to one.
        for (const check of repeatCheck && fresh ? [0, 1] : [0]) {
          const free = state.free - jobs - check - fresh * DISCOVER_VOTES_PER_FINDING
          const dry = fresh ? 0 : state.dry + 1
          const found = state.found || fresh > 0
          if (dry >= dryLimit || round >= maxRounds) {
            settle(free, found)
          } else {
            // Runs that reach the same state go on alike; dry stays below the limit, so under 2.
            next.set(free * 4 + dry * 2 + (found ? 1 : 0), { free, dry, found })
          }
        }
      }
    }
    states = [...next.values()]
  }
  return range
}

/**
 * The agent range a revision 7 run can use, computed from the planner's own rules. `low` is a true
 * floor: the scout returns no map (one area) and no finder reports anything, so the loop stops
 * after its dry rounds and Rank never runs. `high` is a true ceiling over every map (one to eight
 * areas) and every count of new findings per round, Rank included; the planner never starts work
 * its budget cannot finish, so it stays within `maxAgents`. `capped`: the budget, not the depth,
 * bounds the worst case (every area mapped and every finder at the schema's limit each round).
 * The number of finders does not change the count: jobs are areas × lenses and finders only take
 * turns.
 */
export function estimateDiscoverAgents(
  lensCount: number,
  depth: DiscoverDepth,
  maxAgents: number
): { low: number; high: number; capped: boolean } {
  const lenses = Math.max(1, lensCount)
  const budget = Math.max(DISCOVER_MIN_AGENTS, Math.min(DISCOVER_MAX_AGENTS_CEILING, maxAgents))
  const ranges = Array.from({ length: DISCOVER_MAX_AREAS }, (_, index) =>
    discoverRunRange(index + 1, lenses, depth, budget)
  )
  // Every job at the schema's limit, and the round's repeat check.
  const fullRound =
    DISCOVER_MAX_AREAS * lenses * (1 + DISCOVER_VOTES_PER_FINDING * DISCOVER_MAX_FINDINGS_PER_JOB) +
    1
  return {
    low: Math.min(...ranges.map((range) => range.low)),
    high: Math.max(...ranges.map((range) => range.high)),
    // One call goes to the scout and one stays reserved for Rank.
    capped: budget - 2 < DISCOVER_DEPTH_ROUNDS[depth].maxRounds * fullRound
  }
}

export function requiredDiscoverCallLimit(maxCandidates: number): number {
  return 4 + maxCandidates * 2 + (maxCandidates > 1 ? 2 : 0)
}

/** A named host and who asked for the run, as a Start carries them in its draft. */
export type LocalWorkflowLaunchChoice = Pick<
  LocalWorkflowDraft,
  'runsOnHost' | 'runsOnHostId' | 'forceHost' | 'requestedBy' | 'requestedById' | 'request'
>

/** The launch choice with blank values left out, so a draft without one is unchanged. */
export function localWorkflowLaunchChoice(
  input: LocalWorkflowLaunchChoice
): LocalWorkflowLaunchChoice {
  const fields = {
    runsOnHost: input.runsOnHost?.trim(),
    runsOnHostId: input.runsOnHostId?.trim(),
    forceHost: input.forceHost?.trim(),
    requestedBy: input.requestedBy?.trim(),
    requestedById: input.requestedById,
    request: input.request?.trim()
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value)
  ) as LocalWorkflowLaunchChoice
}

/** A Start draft for a workflow graph; the legacy preset fields keep neutral values. */
export function createLocalWorkflowGraphDraft(
  input: {
    prompt: string
    graph: LocalWorkflowGraphDraft
    access?: LocalWorkflowAccess
    contextSources?: WorkflowContextSource[]
    includeWorkspace?: boolean
    runsOn?: WorkflowRunsOn
    concurrency?: number
    scopeIds?: string[]
    skipEarlierRuns?: boolean
    focusFinding?: string
    budgetRootId?: string
  } & LocalWorkflowLaunchChoice
): LocalWorkflowDraft {
  const draft = createLocalWorkflowDraft('council', input.prompt)
  return {
    ...draft,
    graph: input.graph,
    ...(input.runsOn ? { runsOn: input.runsOn } : {}),
    ...(input.focusFinding ? { focusFinding: input.focusFinding } : {}),
    ...(input.skipEarlierRuns ? { skipEarlierRuns: true as const } : {}),
    ...(input.budgetRootId ? { budgetRootId: input.budgetRootId } : {}),
    ...localWorkflowLaunchChoice(input),
    // Shown as "Find it from my description"; sent as is, so older hosts accept it.
    access: input.access ?? 'workspace-read',
    ...(input.contextSources?.length ? { contextSources: input.contextSources } : {}),
    ...(input.includeWorkspace === undefined ? {} : { includeWorkspace: input.includeWorkspace }),
    concurrency: input.concurrency ?? draft.concurrency,
    scopeIds: input.scopeIds ?? []
  }
}

export function createLocalWorkflowDraft(
  preset: LocalWorkflowPreset,
  prompt = ''
): LocalWorkflowDraft {
  // Council: up to six members answer and rank, plus one chairman call. The host recomputes the
  // exact limit from the chosen members; Discover is bounded by its agent ceiling.
  const callLimit = preset === 'council' ? COUNCIL_MAX_MEMBERS * 2 + 1 : DISCOVER_DEFAULT_MAX_AGENTS
  return {
    prompt,
    capability: 'frozen-analysis',
    seats: [],
    synthesizerId: 'seat-1',
    scopeIds: [],
    access: 'workspace-read',
    runsOn: 'fleet',
    ...(preset === 'council' ? { council: { memberIds: [] } } : {}),
    concurrency: 6,
    callLimit,
    attemptLimit: 3,
    maxHostAttempts: callLimit * 3,
    discover: {
      // Legacy revision 1-6 fields: working-agent drafts still use them, and older drafts and
      // replays stay valid.
      dimensions: ['Correctness', 'Actual user path', 'Reliability / resume'],
      lenses: [
        'Correctness: disprove the mechanism or factual claim',
        'Actual occurrence: disprove the trigger or impact in the supported user path'
      ],
      minimumSeverity: 'medium',
      maxCandidates: 12,
      finderIds: [],
      lensIds: ['correctness', 'reliability', 'security'],
      depth: 'thorough',
      focus: [],
      maxAgents: DISCOVER_DEFAULT_MAX_AGENTS
    }
  }
}
