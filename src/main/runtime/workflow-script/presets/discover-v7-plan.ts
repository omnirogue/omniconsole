import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import {
  DISCOVER_DEPTH_ROUNDS,
  DISCOVER_LENS_IDS,
  DISCOVER_MAX_AGENTS_CEILING,
  DISCOVER_MAX_FINDERS,
  type DiscoverDepth
} from '../../../../shared/local-workflow-draft'

/**
 * Pure planning rules for Discover revision 7. The program and the projection both replay these
 * over accepted results, so every choice here (jobs, finders, verifiers, dedup, budget) must be a
 * function of the frozen config and earlier results only, never of completion order.
 */
export type DiscoverV7Config = {
  seats: ResolvedLocalWorkflowSeat[]
  finderIds: string[]
  rankerId: string
  lensIds: string[]
  depth: DiscoverDepth
  focus: string[]
  maxAgents: number
  access: 'workspace-read' | 'frozen'
  /** Frozen workspace path; an absolute finding path inside it dedups like the relative one. */
  workspaceRoot?: string
  /**
   * Seats frozen at admission as ones whose calls take their account one at a time (a Codex
   * login due to refresh). Votes go around them while another family can verify, and each takes
   * at most one finder job a round while another finder exists.
   */
  serializedSeatIds?: string[]
  /**
   * Admitted before rules 2 (DISCOVER_V7_RULES), so it plans as it ran: finders rotate plainly
   * and a finder job reports only the findings it keeps votes for.
   */
  firstRules?: true
}
export type DiscoverV7Area = { name: string; files: string[]; why: string }
export type DiscoverV7Severity = 'low' | 'medium' | 'high' | 'critical'
export type DiscoverV7RawFinding = {
  title: string
  file: string
  line: number
  endLine: number | null
  severity: DiscoverV7Severity
  trigger: string
  scenario: string
  evidence: string
  fix: string
}
export type DiscoverV7Batch = {
  findings: DiscoverV7RawFinding[]
  omitted: number
  /** Workspace-relative files the finder opened; answers from earlier builds may lack it. */
  filesRead?: string[]
}
/** A repeat check's answer: every new finding of the round in exactly one root-cause group. */
export type DiscoverV7Repeats = { groups: { findingIds: string[]; rootCause: string }[] }
export type DiscoverV7Vote = {
  verdict: 'real' | 'refuted' | 'unjudged'
  reason: string
  evidence: string
  /** Workspace-relative files the verifier opened; votes from earlier builds may lack it. */
  filesRead?: string[]
}
export type DiscoverV7Status = 'confirmed' | 'refuted' | 'unverified'
export type DiscoverV7Job = {
  round: number
  areaIndex: number
  lensIndex: number
  lensId: string
  callId: string
  seatId: string
}
/** Votes are kept for `findingLimit` findings; up to `reportLimit` may use what other jobs leave. */
export type DiscoverV7RoundJob = DiscoverV7Job & { findingLimit: number; reportLimit: number }
export type DiscoverV7Record = {
  id: string
  round: number
  areaIndex: number
  lensId: string
  findCallId: string
  finderId: string
  finding: DiscoverV7RawFinding
  /** The earlier report of the same defect; a duplicate is not verified again. */
  duplicateOf?: string
  /** Verifier seat per verify lens; absent on a duplicate. */
  verifiers?: string[]
}
export type DiscoverV7Ledger = {
  /**
   * Planned calls, including the scout and the votes a round's finder jobs keep in reserve until
   * their batches say how many fresh findings need them; failed calls still count.
   */
  used: number
  /** Finder jobs started so far; a capped round starts where the previous rounds stopped. */
  jobsRun: number
  /** Calls the current round keeps for its repeat check (0 or 1) until it runs or is skipped. */
  repeatCheck: number
  /** Finder jobs that returned a batch, and those that returned nothing. */
  searched: number
  failed: number
  records: DiscoverV7Record[]
  dropped: string[]
}
export type DiscoverV7Plan = {
  config: DiscoverV7Config
  verifierPool: ResolvedLocalWorkflowSeat[]
  maxRounds: number
  dryLimit: number
}

export const DISCOVER_V7_VERIFY_LENSES = ['correctness', 'reachability', 'reproduction'] as const
const LENS_LABELS: Record<string, string> = {
  correctness: 'Correctness',
  reliability: 'Reliability',
  security: 'Security',
  performance: 'Performance',
  'user-path': 'User path',
  'data-integrity': 'Data integrity'
}
const DEPTH_LABELS: Partial<Record<string, string>> = {
  quick: 'Quick',
  thorough: 'Thorough',
  exhaustive: 'Exhaustive'
}

export function discoverV7Plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function discoverV7LensLabel(lensId: string): string {
  return LENS_LABELS[lensId] ?? lensId
}

function canVerify(seat: ResolvedLocalWorkflowSeat): boolean {
  return seat.lineage !== 'google' && seat.lineage !== 'unknown'
}

export function planDiscoverV7(config: DiscoverV7Config): DiscoverV7Plan {
  const lineage = (id: string) => config.seats.find((entry) => entry.id === id)?.lineage
  const ranker = config.seats.find((entry) => entry.id === config.rankerId)
  const depth = Object.hasOwn(DISCOVER_DEPTH_ROUNDS, config.depth)
    ? DISCOVER_DEPTH_ROUNDS[config.depth]
    : undefined
  if (
    !depth ||
    config.finderIds.length < 1 ||
    config.finderIds.length > DISCOVER_MAX_FINDERS ||
    new Set(config.finderIds).size !== config.finderIds.length ||
    config.finderIds.some((id) => (lineage(id) ?? 'unknown') === 'unknown') ||
    !ranker ||
    !canVerify(ranker) ||
    config.lensIds.length < 1 ||
    config.lensIds.length > DISCOVER_LENS_IDS.length ||
    new Set(config.lensIds).size !== config.lensIds.length ||
    config.lensIds.some((id) => !(DISCOVER_LENS_IDS as readonly string[]).includes(id)) ||
    !Number.isInteger(config.maxAgents) ||
    config.maxAgents < 1 ||
    config.maxAgents > DISCOVER_MAX_AGENTS_CEILING
  ) {
    throw new Error(
      'Discover requires one to four finders, a non-Google ranker, one to six known lenses, a depth and 1-400 agents'
    )
  }
  return {
    config,
    verifierPool: config.seats.filter(canVerify),
    maxRounds: depth.maxRounds,
    dryLimit: depth.dryLimit
  }
}

export function discoverV7DepthLabel(depth: DiscoverDepth): string {
  return DEPTH_LABELS[depth] ?? depth
}

/** The first job, in job order, that the plain rotation gives the finder at `finderIndex`. */
function firstRotationJob(plan: DiscoverV7Plan, finderIndex: number, round: number) {
  const finders = plan.config.finderIds.length
  for (let areaIndex = 0; areaIndex < finders; areaIndex++) {
    const lensIndex = (((finderIndex - round - areaIndex) % finders) + finders) % finders
    if (lensIndex < plan.config.lensIds.length) {
      return { areaIndex, lensIndex }
    }
  }
  return { areaIndex: 0, lensIndex: 0 }
}

/**
 * Finders rotate across areas, lenses and rounds so each area meets several model families. A
 * serialized seat runs one call at a time, so while another finder exists it keeps only its first
 * job of the round and the rest go round the others. Coordinates alone decide, as replay needs.
 * A run admitted before that rule keeps the plain rotation it ran with.
 */
export function discoverV7FinderId(
  plan: DiscoverV7Plan,
  areaIndex: number,
  lensIndex: number,
  round: number
): string {
  const { finderIds, serializedSeatIds, firstRules } = plan.config
  const turn = areaIndex + lensIndex + round
  const seatId = finderIds[turn % finderIds.length]
  const serialized = new Set(serializedSeatIds ?? [])
  const open = finderIds.filter((id) => !serialized.has(id))
  if (firstRules || !serialized.has(seatId) || !open.length) {
    return seatId
  }
  const first = firstRotationJob(plan, finderIds.indexOf(seatId), round)
  return first.areaIndex === areaIndex && first.lensIndex === lensIndex
    ? seatId
    : open[turn % open.length]
}

export function discoverV7Jobs(
  plan: DiscoverV7Plan,
  areas: readonly DiscoverV7Area[],
  round: number
): DiscoverV7Job[] {
  return areas.flatMap((_, areaIndex) =>
    plan.config.lensIds.map((lensId, lensIndex) => ({
      round,
      areaIndex,
      lensIndex,
      lensId,
      callId: `find/r${round}/${areaIndex}/${lensId}`,
      seatId: discoverV7FinderId(plan, areaIndex, lensIndex, round)
    }))
  )
}

export function discoverV7FindingId(job: DiscoverV7Job, index: number): string {
  return `r${job.round}-a${job.areaIndex}-${job.lensId}-${index}`
}

/** Inverse of discoverV7FindingId; the lens id may itself contain dashes. */
export function parseDiscoverV7FindingId(
  plan: DiscoverV7Plan,
  id: string
): { job: DiscoverV7Job; index: number } | undefined {
  const match = /^r(\d+)-a(\d+)-([a-z-]+)-(\d+)$/.exec(id)
  const lensIndex = match ? plan.config.lensIds.indexOf(match[3]) : -1
  if (!match || lensIndex === -1) {
    return undefined
  }
  const round = Number(match[1])
  const areaIndex = Number(match[2])
  return {
    index: Number(match[4]),
    job: {
      round,
      areaIndex,
      lensIndex,
      lensId: match[3],
      callId: `find/r${round}/${areaIndex}/${match[3]}`,
      seatId: discoverV7FinderId(plan, areaIndex, lensIndex, round)
    }
  }
}

/** Rotates verifiers by the finding's own coordinates, so the id alone names its verifiers. */
export function discoverV7VerifierOffset(job: DiscoverV7Job, index: number): number {
  return job.areaIndex + job.lensIndex + job.round + index
}

/**
 * Verifiers never include Google seats and prefer families other than the finder's. Among those,
 * seats frozen as serialized take no votes while an unserialized one can take them, so votes never
 * queue behind one account; the family rule still comes first.
 */
export function discoverV7Verifiers(
  plan: DiscoverV7Plan,
  finderId: string,
  offset: number
): string[] {
  const finder = plan.config.seats.find((seat) => seat.id === finderId)
  const others = plan.verifierPool.filter((seat) => seat.lineage !== finder?.lineage)
  const eligible = others.length ? others : plan.verifierPool
  const serialized = new Set(plan.config.serializedSeatIds ?? [])
  const open = eligible.filter((seat) => !serialized.has(seat.id))
  const pool = open.length ? open : eligible
  return DISCOVER_V7_VERIFY_LENSES.map((_, index) => pool[(offset + index) % pool.length].id)
}

/** Forward slashes, no leading ./, and relative to the workspace when it lies inside it. */
export function discoverV7Path(file: string, workspaceRoot?: string): string {
  const path = file.trim().replace(/\\/g, '/')
  const root = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  return relative.replace(/^(\.\/)+/, '')
}

export function discoverV7Location(finding: DiscoverV7RawFinding): string {
  const file = finding.file.trim()
  return finding.endLine !== null && finding.endLine > finding.line
    ? `${file}:${finding.line}-${finding.endLine}`
    : `${file}:${finding.line}`
}

export function discoverV7VerifyCallId(recordId: string, lens: string): string {
  return `verify/${recordId}/${lens}`
}

/** The round's repeat check runs in Find: a round ends when its findings are grouped. */
export function discoverV7RepeatCallId(round: number): string {
  return `find/r${round}/repeats`
}

/** The scout may not return a map; Discover then searches the whole focus as one area. */
export function discoverV7FallbackArea(config: DiscoverV7Config): DiscoverV7Area {
  return {
    name: config.focus.length ? 'Focus' : 'Workspace',
    files: config.focus.length ? [...config.focus] : ['.'],
    why: 'The scout did not return a map, so Discover searches the whole focus as one area.'
  }
}
