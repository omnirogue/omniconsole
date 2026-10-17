import type {
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import type { WorkflowFindRow, WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowWebCheck } from '../../../../shared/workflow-graph-web'
import { workflowTopology } from '../../../../shared/workflow-graph-topology'
import { decideResults } from './workflow-results-decide'

/** Find's kept options, Discover's findings, Decide's decision, or another workflow's items. */
export type WorkflowResultsKind = 'find' | 'discover' | 'decide' | 'items'

type Tally = 'confirmed' | 'refuted' | 'unverified'
/** JEV's triage score (0–4) on a finding; display only, the verdict stays in the tally. */
type JevScore = NonNullable<LocalWorkflowGraphItem['jev']>
type Target = NonNullable<LocalWorkflowGraphRound['targets']>[number]

/**
 * Decide's shown decision: checked by the final guard and skeptic (with or without earlier gaps),
 * not decisive, not fully checked, withheld, or one model's answer.
 */
export type WorkflowDecideStatus =
  | 'checked'
  | 'warnings'
  | 'inconclusive'
  | 'unchecked'
  | 'withheld'
  | 'answer'

/** One result a person can hand to an agent session, with what the run learned about it. */
export type WorkflowResultCandidate = {
  /** `executionId:key`: unique across runs and stable while the run is open. */
  id: string
  /** The run's own key: a Find option's, or a finding's. */
  key: string
  title: string
  detail: string
  /** Find only: what a judge was actually shown for this option (never an owner's own words for
   * a GitHub repository) — what a continuation built from this candidate must use instead of
   * detail, which stays for on-screen display and export only. */
  judgeText?: string
  /** "path:line" as the run reported it; the session re-checks it. */
  location?: string
  /** Other reports the run merged into this one, as they were written. */
  also?: { title: string; detail: string; location?: string }[]
  severity?: string
  tally?: Tally
  unchecked?: true
  /** JEV set it aside as a non-finding, so no reviewer checked it. */
  screened?: true
  /** Live JEV verify set it aside (refuted) after the reviewers left it unverified. */
  refutedBy?: 'jev'
  /** JEV verify's probability that it is a real defect. */
  jevVerify?: number
  /** JEV set it aside, then a later report it never saw put it back to unverified. */
  resurfaced?: true
  /** Resurfaced after live JEV verify set it aside at this probability. */
  setAsideAt?: number
  jev?: JevScore
  /** A frontier model's impact rating (1–5), when the run triaged by impact. */
  impact?: { score: number; why: string }
  /** Where the app found the finder's quote in the file, or why it could not look. */
  evidence?: NonNullable<LocalWorkflowGraphItem['evidence']>['status']
  /** The report's value order (1 first), why it matters and the next concrete step. */
  rank?: number
  why?: string
  next?: string
  /** A run that reads pages: the app's own checks of the web quotes in `why` and `next`. */
  webChecks?: WorkflowWebCheck[]
  /** Find: JEV's overall score (0–4), each rubric line's score, the final place, the check. */
  score?: number
  /** Find: JEV could not score it; never read as a low score. */
  notScored?: true
  criteria?: { name: string; score: number }[]
  place?: number
  winner?: true
  check?: WorkflowFindRow['check']
  /** Decide: the rubric lines this finalist led in the comparison. */
  leads?: string[]
  /** Decide: how far the shown decision was checked. */
  decision?: WorkflowDecideStatus
  /** GitHub's facts for the repository an option names. */
  facts?: string
  /** Ticked when the list opens: Find's winner, the findings that held up. */
  preselected: boolean
}

export type WorkflowResults = {
  kind: WorkflowResultsKind
  candidates: WorkflowResultCandidate[]
  /** How many options the run considered, when that is more than it kept (Find). */
  considered?: number
  /** The run's gaps, carried whole and apart from the results so no cut can drop them. */
  warnings?: string[]
}

const TALLY_ORDER: Record<Tally, number> = { confirmed: 0, unverified: 1, refuted: 2 }
/** Held up first, then the unchecked, then the refuted; the ones JEV set aside come last. */
const targetGroup = (target: Target) => (target.screened ? 3 : TALLY_ORDER[target.tally])
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function findResults(executionId: string, trail: WorkflowFindTrail): WorkflowResults | undefined {
  const kept = trail.stage === 'done' ? (trail.rows ?? []).filter((row) => row.kept) : []
  if (!kept.length) {
    return undefined
  }
  const best = trail.winner?.key ?? kept[0]!.key
  const criteria = trail.criteria ?? []
  return {
    kind: 'find',
    considered: trail.pool,
    candidates: kept.map((row) => {
      const scored = criteria.flatMap((name, index) => {
        const score = row.scores[index]
        return typeof score === 'number' ? [{ name, score }] : []
      })
      return {
        id: `${executionId}:${row.key}`,
        key: row.key,
        title: row.title,
        detail: row.detail,
        judgeText: row.judgeText,
        ...(row.score !== undefined ? { score: row.score } : {}),
        ...(row.notScored ? { notScored: true as const } : {}),
        ...(scored.length ? { criteria: scored } : {}),
        ...(row.finalPlace !== undefined ? { place: row.finalPlace } : {}),
        ...(row.key === trail.winner?.key ? { winner: true as const } : {}),
        ...(row.check ? { check: row.check } : {}),
        ...(row.facts ? { facts: row.facts } : {}),
        preselected: row.key === best
      }
    })
  }
}

/** Each item once, as its latest round reported it, in the order the run first listed them. */
function latestByKey<T extends LocalWorkflowGraphItem>(rounds: T[][]): T[] {
  const byKey = new Map<string, T>()
  for (const item of rounds.flat()) {
    byKey.set(item.key, item)
  }
  return [...byKey.values()]
}

function itemCandidate(
  executionId: string,
  item: LocalWorkflowGraphItem
): Omit<WorkflowResultCandidate, 'preselected'> {
  return {
    id: `${executionId}:${item.key}`,
    key: item.key,
    title: item.title,
    detail: item.detail,
    ...(item.location.trim() ? { location: item.location.trim() } : {}),
    ...(item.alsoReported?.length
      ? {
          also: item.alsoReported.map((report) => ({
            title: report.title,
            detail: report.detail,
            ...(report.location.trim() ? { location: report.location.trim() } : {})
          }))
        }
      : {}),
    ...(item.severity !== 'none' ? { severity: item.severity } : {}),
    ...(item.jev ? { jev: item.jev } : {}),
    ...(item.impact ? { impact: item.impact } : {}),
    ...(item.evidence ? { evidence: item.evidence.status } : {})
  }
}

/** The run's steps in dependency order: a later step works from the earlier ones' output. */
function stepsInOrder(run: LocalWorkflowGraphRun) {
  const order = workflowTopology(run.spec).order ?? run.spec.steps.map((step) => step.id)
  return order.flatMap((id) => run.steps.find((step) => step.id === id) ?? [])
}

function graphResults(view: LocalWorkflowView, run: LocalWorkflowGraphRun) {
  const kind: WorkflowResultsKind = run.spec.template === 'discover' ? 'discover' : 'items'
  const steps = stepsInOrder(run)
  // The last step that reviewed items one by one holds the verdicts (Discover's Verify).
  const reviewed = steps.findLast((step) => step.rounds.some((round) => round.targets))
  if (reviewed) {
    // Investigate: a claim that names no evidence is open, however the check voted.
    const unbacked = (target: Target) =>
      run.spec.template === 'investigate' && target.tally === 'confirmed' && !target.location.trim()
    // The app's settled claim outranks the reviewers' tally: an open claim is never confirmed here.
    const claims = new Map((run.claims ?? []).map((row) => [row.key, row]))
    const open = (target: Target) => {
      const claim = claims.get(target.key)
      return target.tally === 'confirmed' && !!claim && claim.status !== 'confirmed'
    }
    const targets = latestByKey(reviewed.rounds.map((round): Target[] => round.targets ?? [])).map(
      (target): Target =>
        unbacked(target) || open(target) ? { ...target, tally: 'unverified' } : target
    )
    const placed = new Map((run.ranking ?? []).map((row, index) => [row.key, { row, index }]))
    const position = (target: Target) => placed.get(target.key)?.index ?? Number.POSITIVE_INFINITY
    // Within each verdict: the report's ranking, then impact, then severity, never JEV (on a real
    // run JEV's order agreed with frontier impact at 0.06–0.13, the finder's severity at 0.55–0.64).
    const order = (left: Target, right: Target) =>
      targetGroup(left) - targetGroup(right) ||
      Number(placed.has(right.key)) - Number(placed.has(left.key)) ||
      (placed.has(left.key) ? position(left) - position(right) : 0) ||
      (right.impact?.score ?? 0) - (left.impact?.score ?? 0) ||
      (SEVERITY_ORDER[left.severity] ?? 4) - (SEVERITY_ORDER[right.severity] ?? 4)
    const candidates = targets.toSorted(order).map((target) => {
      const report = placed.get(target.key)
      const checks = [
        ...(target.webChecks ?? []),
        ...(claims.get(target.key)?.webChecks ?? []),
        ...(report?.row.webChecks ?? [])
      ]
      const webChecks = [...new Map(checks.map((check) => [JSON.stringify(check), check])).values()]
      return {
        ...itemCandidate(view.executionId, target),
        ...(report
          ? {
              rank: report.index + 1,
              ...(report.row.why ? { why: report.row.why } : {}),
              ...(report.row.next ? { next: report.row.next } : {})
            }
          : {}),
        // Every check that applies, from the item, its claim and its ranking, ranked or not.
        ...(target.webChecks || report?.row.webChecks || claims.has(target.key)
          ? { webChecks }
          : {}),
        tally: target.tally,
        ...(target.unchecked ? { unchecked: true as const } : {}),
        ...(target.screened ? { screened: true as const } : {}),
        ...(target.refutedBy ? { refutedBy: target.refutedBy } : {}),
        ...(target.jevVerify !== undefined ? { jevVerify: target.jevVerify } : {}),
        ...(target.resurfaced ? { resurfaced: true as const } : {}),
        ...(target.setAsideAt !== undefined ? { setAsideAt: target.setAsideAt } : {}),
        preselected: target.tally === 'confirmed' && !target.screened
      }
    })
    return candidates.length ? { kind, candidates } : undefined
  }
  const lists = new Set(run.spec.steps.filter((step) => step.list).map((step) => step.id))
  const listed = steps.findLast((step) => lists.has(step.id))
  const items = latestByKey((listed?.rounds ?? []).map((round) => round.items ?? []))
  return items.length
    ? {
        kind,
        candidates: items.map((item) => ({
          ...itemCandidate(view.executionId, item),
          preselected: false
        }))
      }
    : undefined
}

/**
 * What a settled run offers to act on, or nothing: Find's kept options (the winner ticked),
 * a graph run's reviewed items (the confirmed ones ticked) or its last list, and a legacy
 * Discover report (every item held up, so all are ticked).
 */
export function workflowResults(view: LocalWorkflowView): WorkflowResults | undefined {
  if (!['completed', 'failed', 'cancelled'].includes(view.state)) {
    return undefined
  }
  const run = view.graphRun
  if (run) {
    return run.find
      ? findResults(view.executionId, run.find)
      : run.spec.template === 'decide'
        ? decideResults(view, run)
        : graphResults(view, run)
  }
  const items = view.discoverRun?.report?.items ?? []
  if (!items.length) {
    return undefined
  }
  return {
    kind: 'discover',
    candidates: items.map((item) => {
      const key = item.findingIds[0] ?? `rank-${item.rank}`
      return {
        id: `${view.executionId}:${key}`,
        key,
        title: item.title,
        detail: `What goes wrong: ${item.scenario.trim()}\n\nFix: ${item.fix.trim()}`,
        ...(item.location.trim() ? { location: item.location.trim() } : {}),
        severity: item.severity,
        tally: 'confirmed' as const,
        preselected: true
      }
    })
  }
}
