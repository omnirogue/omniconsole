import type { WorkflowRunResult, WorkflowRunTarget } from './workflow-run-result'
import type { WorkflowReportRank } from './workflow-report-ranking'

export const DISCOVER_OMNIOS_PICKS = ['Start', 'Dig deeper', 'Not now'] as const
export type DiscoverOmniosPick = (typeof DISCOVER_OMNIOS_PICKS)[number]
/** The most findings one page asks about: what a Decisions card shows as its own controls. */
export const DISCOVER_OMNIOS_MAX_FINDINGS = 8
/** Confirmed findings ranked this high are ticked Start; everything else is ticked Not now. */
const DISCOVER_OMNIOS_START_RANK = 3
/** The part of a title the page's edits name a finding by ("2. <title>": "Start"). */
const DISCOVER_OMNIOS_KEY_TITLE = 60

export type DiscoverOmniosStatus =
  | 'confirmed'
  | 'jev-confirmed'
  | 'unverified'
  | 'unchecked'
  | 'single-pass'

export type DiscoverOmniosFinding = {
  /** 1-based, the order on the page and in the person's picks ("2. <title>: Start"). */
  n: number
  key: string
  title: string
  status: DiscoverOmniosStatus
  impact?: WorkflowRunTarget['impact']
  votes: WorkflowRunTarget['votes']
  repeats: number
  jevVerify?: number
  effort?: WorkflowReportRank['effort']
  risk?: WorkflowReportRank['risk']
  severity: string
  location: string
  why: string
  next: string
  independent?: boolean
  /** The app's check of the finder's quote, when it found a problem with it. */
  evidence?: string
  detail: string
  alsoReported?: WorkflowRunTarget['alsoReported']
  recommended: DiscoverOmniosPick
}

export type DiscoverRunSource = {
  commit: string
  branch: string | null
  origin?: string
  dirty: boolean
}

export type DiscoverOmniosRun = {
  executionId?: string
  workspaceId?: string
  source?: DiscoverRunSource
  /** Full measurements also retain off-page findings and refutations. */
  measurement?: Pick<
    WorkflowRunResult,
    'executionId' | 'results' | 'calls' | 'usage' | 'state' | 'degraded'
  >
  rankingComplete?: boolean
  goal: string
  template: string
  workspace: string
  minutes: number | null
  requestedBy?: string
  requestedById?: string
  request?: string
  summary: string
  findings: DiscoverOmniosFinding[]
  /** Legacy title-only overflow; new runs keep all findings with evidence and controls. */
  more: string[]
  /** What the run found and set aside, so a person sees what is not on the page and why. */
  setAside: { refuted: number; jev: number; noFile: number }
  models: string[]
  /** What the run could not cover, and agent calls that failed: shown, never folded away. */
  gaps: string[]
  /** The full report, as the run wrote it. */
  report: string
}

/** Why a result is not one to act on, or null when it is. */
export function setAsideAs(target: WorkflowRunTarget): keyof DiscoverOmniosRun['setAside'] | null {
  if (target.tally === 'refuted') {
    return target.refutedBy === 'jev' ? 'jev' : 'refuted'
  }
  if (target.screened) {
    return 'jev'
  }
  return target.preVerify?.dropped ? 'noFile' : null
}

function statusOf(target: WorkflowRunTarget): DiscoverOmniosStatus | null {
  if (setAsideAs(target)) {
    return null
  }
  if (target.singlePass) {
    return 'single-pass'
  }
  if (target.tally === 'confirmed') {
    return target.confirmedBy === 'jev' ? 'jev-confirmed' : 'confirmed'
  }
  return target.unchecked ? 'unchecked' : 'unverified'
}

/** How the page's edits name a finding: its number and the start of its title. */
export function discoverOmniosKey(finding: Pick<DiscoverOmniosFinding, 'n' | 'title'>): string {
  const chars = Array.from(finding.title.replace(/\s+/g, ' ').trim())
  const title =
    chars.length > DISCOVER_OMNIOS_KEY_TITLE
      ? `${chars
          .slice(0, DISCOVER_OMNIOS_KEY_TITLE - 1)
          .join('')
          .trimEnd()}…`
      : chars.join('')
  return `${finding.n}. ${title}`
}

/** The report's opening, cut at a sentence end: the lines a person decides from. */
export function discoverOmniosSummary(markdown: string | null, limit = 600): string {
  const opening =
    (markdown ?? '')
      // A fenced block may hold blank lines; it is never the opening.
      .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*/g, '')
      .split(/\n\s*\n/)
      .map((block) =>
        block
          .replace(/^#+\s.*$/gm, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .find((block) => block.length > 0 && !block.startsWith('|') && !block.startsWith('```')) ?? ''
  // Code points, so a cut never splits a character in two.
  const chars = Array.from(opening)
  if (chars.length <= limit) {
    return opening
  }
  const cut = chars.slice(0, limit).join('')
  // One character more shows whether a stop at the very end ends a sentence.
  const window = chars.slice(0, limit + 1).join('')
  let end = -1
  for (const stop of window.matchAll(/[.!?](?=\s|$)/g)) {
    if (stop.index < cut.length) {
      end = stop.index
    }
  }
  return end > cut.length / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`
}

/** The exact actionable order used by both the decision pages and benchmark scoring. */
export function discoverOmniosOrderedTargets(result: Pick<WorkflowRunResult, 'results'>) {
  const eligible = [
    ...new Map(result.results.targets.map((target) => [target.key, target])).values()
  ].filter((target) => statusOf(target))
  const ranks = new Map((result.results.ranking ?? []).map((rank) => [rank.key, rank]))
  return [...eligible]
    .sort((a, b) => {
      const confirmed = Number(statusOf(b) === 'confirmed') - Number(statusOf(a) === 'confirmed')
      if (confirmed) {
        return confirmed
      }
      const ar = ranks.get(a.key),
        br = ranks.get(b.key)
      if (ar && br) {
        return ar.rank - br.rank
      }
      if (ar || br) {
        return ar ? -1 : 1
      }
      return (b.impact?.score ?? 0) - (a.impact?.score ?? 0)
    })
    .map((target) => {
      const rank = ranks.get(target.key)
      return {
        target,
        why: rank?.why ?? '',
        next: rank?.next ?? '',
        independent: rank?.independent
      }
    })
}

/**
 * The findings a person acts on, in the report's ranking: every result not refuted, set aside by
 * JEV or citing no file that exists. Confirmed results come first, with full overflow retained.
 */
export function discoverOmniosRun(
  result: WorkflowRunResult,
  context: { goal: string; workspace: string }
): DiscoverOmniosRun {
  const latestTargets = [
    ...new Map(result.results.targets.map((target) => [target.key, target])).values()
  ]
  const eligible = latestTargets.filter((target) => statusOf(target))
  const ranking = result.results.ranking ?? []
  const ranks = new Map(ranking.map((rank) => [rank.key, rank]))
  const rankingComplete =
    eligible.length > 0 &&
    eligible.every((target) => ranks.has(target.key)) &&
    ranks.size === ranking.length &&
    new Set(ranking.map((rank) => rank.rank)).size === ranking.length &&
    ranking.every((rank) => Number.isSafeInteger(rank.rank) && rank.rank > 0)
  const ordered = discoverOmniosOrderedTargets(result).map(({ target }) => target)
  let confirmed = 0
  const findings = ordered.map((target, index) => {
    const status = statusOf(target)!
    const rank = ranks.get(target.key)
    if (status === 'confirmed') {
      confirmed += 1
    }
    return {
      n: index + 1,
      key: target.key,
      title: target.title,
      status,
      severity: target.severity ?? '',
      location: target.location,
      why: rank?.why ?? '',
      next: rank?.next ?? '',
      ...(rank?.independent !== undefined ? { independent: rank.independent } : {}),
      ...(rank?.effort ? { effort: rank.effort } : {}),
      ...(rank?.risk ? { risk: rank.risk } : {}),
      ...(target.impact ? { impact: target.impact } : {}),
      votes: target.votes,
      repeats: target.repeats,
      ...(target.jevVerify !== undefined ? { jevVerify: target.jevVerify } : {}),
      ...(target.evidence ? { evidence: target.evidence } : {}),
      ...(target.alsoReported?.length ? { alsoReported: target.alsoReported } : {}),
      detail: [
        target.detail,
        ...(target.alsoReported ?? []).map(
          (report) => `Also reported: ${report.title} (${report.location})\n${report.detail}`
        )
      ].join('\n\n'),
      recommended:
        rankingComplete && status === 'confirmed' && confirmed <= DISCOVER_OMNIOS_START_RANK
          ? ('Start' as const)
          : ('Not now' as const)
    }
  })
  const setAside = { refuted: 0, jev: 0, noFile: 0 }
  const counted = new Set<string>()
  for (const target of latestTargets) {
    const reason = setAsideAs(target)
    if (reason && !counted.has(target.key)) {
      counted.add(target.key)
      setAside[reason] += 1
    }
  }
  const failed = result.calls.filter((call) => call.state === 'failed').length
  const wallClock = result.timing.wallClockMs
  return {
    measurement: {
      executionId: result.executionId,
      results: result.results,
      calls: result.calls,
      usage: result.usage,
      state: result.state,
      ...(result.degraded ? { degraded: result.degraded } : {})
    },
    goal: context.goal,
    template: result.template,
    workspace: context.workspace,
    minutes: typeof wallClock === 'number' ? Math.max(1, Math.round(wallClock / 60_000)) : null,
    ...(result.requestedBy ? { requestedBy: result.requestedBy } : {}),
    ...(result.requestedById ? { requestedById: result.requestedById } : {}),
    ...(result.request ? { request: result.request } : {}),
    summary: discoverOmniosSummary(result.markdown),
    findings,
    rankingComplete,
    more: [],
    setAside,
    models: [...new Set(result.calls.map((call) => call.model).filter((model) => model))],
    gaps: [
      ...result.gaps,
      ...(failed
        ? [`${failed} of ${result.calls.length} agent calls failed, so their part may be missing.`]
        : [])
    ],
    report: (result.markdown ?? '').slice(0, 40_000)
  }
}
